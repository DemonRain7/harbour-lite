"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { merge } = require("../renderer/orb-state");
const { OrbChat } = require("../companion/orb-chat");
const full = () => ({ stateRevision: 1, agent: "main-elaina", chat: { sessionId: "a", historyRevision: 1,
  messages: [{ role: "assistant", content: "hello", parts: [{ type: "image", id: "image-a" }] }], summary: "older context" } });
const progress = () => ({ stateRevision: 2, agent: "main-elaina", chat: { sessionId: "a", historyRevision: 1, detail: "working" } });
test("compact progress retains exact messages, images and summary without serializing them again", () => {
  const previous = merge(null, full()), next = merge(previous, progress());
  assert.equal(next.chat.messages, previous.chat.messages);
  assert.equal(next.chat.summary, "older context"); assert.equal(next.chat.detail, "working"); assert.equal(next.historyReady, true);
  assert.equal(merge(next, full()), null, "late initial state cannot roll back live progress");
});
test("missing/new revisions never reuse another conversation/persona and full hydration restores everything", () => {
  const previous = merge(null, full());
  for (const change of [{ agent: "main-aemeath" }, { chat: { ...progress().chat, sessionId: "b" } }, { chat: { ...progress().chat, historyRevision: 2 } }]) {
    const next = merge(previous, { ...progress(), ...change });
    assert.deepEqual(next.chat.messages, []); assert.equal(next.historyReady, false); assert.equal(next.chat.summary, "");
  }
  const metadata = merge(null, progress());
  assert.equal(metadata.historyReady, false);
  const hydrated = merge(metadata, { ...full(), stateRevision: 3 });
  assert.equal(hydrated.chat.messages[0].parts[0].id, "image-a"); assert.equal(hydrated.historyReady, true);
  const empty = merge(hydrated, { ...full(), stateRevision: 4, chat: { sessionId: "new", historyRevision: 2, messages: [], summary: "" } });
  assert.equal(empty.historyReady, true); assert.deepEqual(empty.chat.messages, []);
});
test("chat snapshots track replacements/appends, but metadata does not scan or clone message content", () => {
  const changes = [], c = new OrbChat({ deviceId: "test", getConfig: () => ({ url: "http://127.0.0.1:1" }),
    agents: [{ agentName: "main-elaina" }], onChange: value => changes.push(value) });
  try {
    const row = c.row("main-elaina"); row.messages = full().chat.messages; row.images.set("image-a", {});
    const initial = c.snapshot(row.agent), revision = initial.historyRevision;
    row.messages.flatMap = () => { throw new Error("progress rescanned all images"); };
    row.detail = "new status"; c.changed(row);
    assert.equal(changes.at(-1).messages, undefined); assert.equal(changes.at(-1).historyRevision, revision);
    delete row.messages.flatMap;
    initial.messages[0].content = "detached";
    assert.equal(row.messages[0].content, "hello", "public snapshots remain detached");
    row.messages = [...row.messages]; c.changed(row);
    assert.ok(changes.at(-1).historyRevision > revision);
    assert.equal(changes.at(-1).lastMessageRevision, initial.lastMessageRevision, "identical hydration does not re-notify");
    row.messages.push({ role: "user", content: "next" }); c.changed(row);
    assert.equal(changes.at(-1).lastMessageRole, "user");
    assert.equal(row.images.has("image-a"), true);
    row.messages = []; c.changed(row); assert.equal(row.images.size, 0);
  } finally { c.dispose(); }
});
