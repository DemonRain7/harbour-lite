const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CompanionStateStore, BUBBLE_LIFETIME_MS } = require("../companion/companion-state");
const { ConversationLink, conversationTarget } = require("../companion/conversation-link");

function setup(t) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
  const store = new CompanionStateStore();
  t.after(() => store.dispose());
  const emit = (type, extra = {}) => store.consume({ __harbour: type, agent: "main-elaina", runId: "reply", ...extra });
  const reply = extra => emit("companion:utterance", { text: "已经回复你的问题。", createdAt: new Date().toISOString(), sessionId: "cs-qq", source: { platform: "qq" }, ...extra });
  return { store, emit, reply, bubble: () => store.snapshot().characters.elaina.bubble };
}

test("reply expires despite concurrent thinking, asks and appearance updates", t => {
  const { store, emit, reply, bubble } = setup(t);
  emit("channel-activity", { phase: "running", runId: "other" });
  reply();
  assert.equal(bubble().sessionId, "cs-qq");
  assert.equal(bubble().agentName, "main-elaina");
  t.mock.timers.tick(1000);
  emit("channel-activity", { phase: "complete" }); // Used to clear the bubble timer.
  emit("log", { msg: "loop:thinking", runId: "other" });
  emit("ask", { kind: "created" }); // Used to invalidate updatedAt, leaving bubble forever.
  store.setAppearance({ theme: "anime-sky" });
  t.mock.timers.tick(BUBBLE_LIFETIME_MS - 1000);
  assert.equal(bubble(), null);
  assert.equal(store.snapshot().characters.elaina.status, "waiting", "expiry cannot cancel the pending ask");
  assert.equal(store.activities.size, 1);
});

test("manual close is scoped to a bubble and survives replay, not a newer reply or another pet", t => {
  const { store, reply, bubble } = setup(t);
  reply();
  const first = bubble();
  reply({ agent: "main-aemeath" });
  assert.equal(store.dismissBubble("elaina", first.id), true);
  reply();
  assert.equal(bubble(), null, "same event cannot resurrect a dismissed notification");
  assert.ok(store.snapshot().characters.aemeath.bubble);
  t.mock.timers.tick(1000);
  reply({ runId: "next", sessionId: "cs-other" });
  const second = bubble();
  assert.equal(store.dismissBubble("elaina", first.id), false);
  t.mock.timers.tick(7000);
  assert.equal(bubble().id, second.id, "previous timer must not close a newer reply");
  assert.equal(store.snapshot().characters.aemeath.bubble, null);
  t.mock.timers.tick(1000);
  assert.equal(bubble(), null);
});

test("old events are not presented as new replies after reconnect", t => {
  const { reply, store } = setup(t);
  reply({ createdAt: new Date(Date.now() - 60_000).toISOString() });
  assert.equal(store.snapshot().characters.elaina, undefined);
});

test("closing a completed reply does not strand the pet in its completed pose", t => {
  const { store, reply, emit, bubble } = setup(t);
  reply();
  emit("channel-activity", { phase: "complete" });
  t.mock.timers.tick(1000);
  store.dismissBubble("elaina", bubble().id);
  t.mock.timers.tick(5000);
  assert.equal(store.snapshot().characters.elaina.status, "idle");
});

test("conversation link waits for Dashboard readiness and latest click wins", () => {
  const link = new ConversationLink(), delivered = [];
  let loading = true;
  const renderer = { isDestroyed: () => false, isLoadingMainFrame: () => loading, send: (...args) => delivered.push(args) };
  link.enqueue({ sessionId: "cs-first", agentName: "main-elaina" });
  link.flush();
  link.enqueue({ sessionId: "cs-second", agentName: "main-aemeath", prompt: "never forwarded" });
  link.ready(renderer);
  assert.equal(delivered.length, 0);
  loading = false;
  link.flush();
  assert.deepEqual(delivered, [["desktop:open-conversation", { sessionId: "cs-second", agentName: "main-aemeath" }]]);
  link.flush();
  assert.equal(delivered.length, 1);
  link.loading(renderer);
  link.enqueue({ sessionId: "cs-after-reload", agentName: "main-elaina" });
  link.flush();
  assert.equal(delivered.length, 1);
  link.ready(renderer);
  assert.equal(delivered.length, 2);
  assert.equal(conversationTarget({ sessionId: "../file", agentName: "main-elaina" }), null);
  assert.equal(link.enqueue({ sessionId: "https://example.com", agentName: "main-elaina" }), false);
});
