"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { OrbFeedback } = require("../companion/orb-feedback");
const { expression } = require("../renderer/orb-expression");
const event = { runId: "run-one", traceId: "child-one", parentTraceId: "root-one", agent: "trajectory-checker", msg: "loop:end", status: "failed", time: 1000 };
function fixture() { const feedback = new OrbFeedback(); feedback.reset("run-one", "session-one", "main-elaina"); return feedback; }

test("failure feedback only accepts same-run structured outcomes, not text or unrelated activity", () => {
  const feedback = fixture();
  for (const wrong of [{ ...event, runId: "other" }, { ...event, sessionId: "other" },
    { ...event, parentTraceId: undefined }, { ...event, status: "interrupted" },
    { ...event, status: "incomplete" }, { ...event, status: "unknown" },
    { ...event, msg: "loop:final", answerPreview: "失败了" },
    { ...event, msg: "loop:tool-result", resultPreview: '{"status":"failed"}' },
    { __harbour: "channel-activity", runId: "run-one", sessionId: "session-one", agent: "main-aemeath", phase: "error" }]) {
    feedback.consume(wrong); assert.equal(feedback.snapshot(), null);
  }
  feedback.consume(event, 2000);
  assert.deepEqual(feedback.snapshot(), { scope: "subagent", label: "子任务执行失败", at: 2000 });
});

test("subagent failure is briefly sad then thinking while Main continues; replay never extends its timer", () => {
  const feedback = fixture(); feedback.consume(event, 2000);
  const state = { connection: "open", chat: { runId: "run-one", phase: "running", failure: feedback.snapshot() } };
  assert.equal(expression(state, 2100).mood, "failed"); assert.equal(expression(state, 2100).resetAt, 7000);
  feedback.consume(event, 6900); assert.equal(feedback.snapshot().at, 2000);
  assert.equal(expression(state, 7000).mood, "thinking"); assert.equal(expression(state, 7000).resetAt, 0);
  assert.equal(expression({ ...state, chat: { ...state.chat, asks: [{}] } }, 2500).mood, "waiting");
  assert.equal(expression({ ...state, chat: { ...state.chat, phase: "stopping" } }, 2500).mood, "thinking");
  assert.equal(expression({ ...state, chat: { ...state.chat, phase: "cancelled" } }, 2500).mood, "idle");
});

test("workflow failures clear only on their own later successful result, not another trace/job or replay", () => {
  const feedback = fixture(), workflow = { ...event, msg: "workflow:result", workflow: "example", jobId: "job-one", status: "failed" };
  feedback.consume(workflow, 2000);
  feedback.consume({ ...workflow, jobId: "job-two", status: "completed", time: 1100 });
  feedback.consume({ ...workflow, traceId: "other-child", status: "completed", time: 1200 });
  assert.equal(feedback.snapshot().scope, "workflow");
  feedback.consume({ ...workflow, status: "completed", time: 1500 }); assert.equal(feedback.snapshot(), null);
  feedback.consume(workflow, 9000); assert.equal(feedback.snapshot(), null, "old WS replay cannot resurrect a resolved failure");
  feedback.consume({ ...workflow, status: "unknown", time: 1600 }); assert.equal(feedback.snapshot(), null);
});

test("reply arrival alone does not erase a failure or falsely show a happy face", () => {
  const feedback = fixture(); feedback.consume(event, 2000);
  feedback.consume({ __harbour: "channel-activity", runId: "run-one", agent: "main-elaina", sessionId: "session-one", phase: "complete" });
  feedback.consume({ ...event, parentTraceId: undefined, traceId: "root-one", agent: "main-elaina", status: "completed", time: 1200 });
  const state = { connection: "open", chat: { phase: "complete", replyReadyAt: 3000, failure: feedback.snapshot() } };
  assert.equal(expression(state, 3100).mood, "failed"); assert.equal(expression(state, 3100).resetAt, 7000);
  assert.equal(expression(state, 7100).mood, "idle"); assert.match(expression(state, 7100).label, /曾失败/);
  feedback.consume({ ...event, status: "completed", time: 1300 });
  assert.equal(expression({ ...state, chat: { ...state.chat, failure: feedback.snapshot() } }, 10100).mood, "complete");
});

test("confirmed final failure overrides transport uncertainty but never changes retry safety", () => {
  const feedback = fixture(); feedback.consume(event, 2000);
  feedback.consume({ __harbour: "channel-activity", runId: "run-one", sessionId: "session-one", agent: "main-elaina", phase: "error", time: 3000 }, 3000);
  const chat = { phase: "uncertain", failure: feedback.snapshot() };
  assert.equal(expression({ connection: "closed", chat }, 9000).mood, "failed");
  assert.equal(expression({ connection: "closed", chat }, 9000).label, "本轮执行失败");
  assert.equal(chat.phase, "uncertain");
  assert.equal(expression({ connection: "closed", chat: { phase: "uncertain" } }, 9000).mood, "idle");
});

test("new run/session and cancellation reset feedback, including late child events", () => {
  const feedback = fixture(); feedback.consume(event); feedback.cancel(); feedback.consume(event);
  assert.equal(feedback.snapshot(), null);
  feedback.reset("next-run", "next-session", "main-aemeath"); feedback.consume(event);
  assert.equal(feedback.snapshot(), null);
  feedback.consume({ ...event, runId: "next-run", agent: "trajectory-checker" }); assert.ok(feedback.snapshot());
  feedback.reset(); assert.equal(feedback.snapshot(), null);
});
