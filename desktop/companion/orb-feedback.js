"use strict";

// Display evidence only. Never changes execution, billing or retry safety.
class OrbFeedback {
  constructor() { this.reset(); }
  reset(runId = null, sessionId = null, agent = null) {
    this.runId = runId; this.sessionId = sessionId; this.agent = agent;
    this.entries = new Map(); this.cancelled = false;
  }
  cancel() { this.cancelled = true; this.entries.clear(); }
  consume(event, now = Date.now()) {
    if (!this.runId || this.cancelled || event?.runId !== this.runId
      || (event.sessionId && event.sessionId !== this.sessionId)) return false;
    let key, scope, label, failed;
    if (event.__harbour === "channel-activity") {
      if (event.agent !== this.agent || event.sessionId !== this.sessionId) return false;
      // `complete` means a reply arrived, not that every delegated task succeeded.
      if (event.phase !== "error") return false;
      key = "task"; scope = "task"; label = "本轮执行失败"; failed = true;
    } else if (event.msg === "loop:end" && typeof event.traceId === "string" && event.traceId
      && typeof event.agent === "string" && ["failed", "completed", "interrupted", "incomplete"].includes(event.status)) {
      const main = !event.parentTraceId && event.agent === this.agent;
      if (!main && !event.parentTraceId) return false;
      key = `loop:${event.traceId}`; scope = main ? "task" : "subagent";
      label = main ? "本轮执行失败" : "子任务执行失败"; failed = event.status === "failed";
    } else if (["workflow:error", "workflow:result", "workflow:progress"].includes(event.msg)
      && typeof event.traceId === "string" && event.traceId && typeof event.workflow === "string"
      && ["failed", "error", "completed", "succeeded"].includes(event.status)) {
      key = `workflow:${event.traceId}:${event.workflow}:${event.jobId || event.action || "default"}`; scope = "workflow";
      label = "工作流执行失败"; failed = ["failed", "error"].includes(event.status);
    } else return false;
    const previous = this.entries.get(key);
    const time = Number.isFinite(event.time) ? event.time : null;
    if (previous && (previous.time !== null && time !== null && time < previous.time)) return false;
    // WS replay and repeated progress must not restart a sad animation.
    if (previous?.failed === failed) {
      if (time !== null && (previous.time === null || time > previous.time)) previous.time = time;
      return false;
    }
    this.entries.set(key, { key, scope, label, failed, time, at: now });
    if (this.entries.size > 128) this.entries.delete(this.entries.keys().next().value);
    return true;
  }
  snapshot() {
    // A final Main failure takes precedence over an earlier child failure.
    const failures = [...this.entries.values()].filter(entry => entry.failed);
    const latest = failures.filter(entry => entry.scope === "task").at(-1)
      || failures.filter(entry => entry.scope === "workflow").at(-1) || failures.at(-1);
    return latest ? { scope: latest.scope, label: latest.label, at: latest.at } : null;
  }
}

module.exports = { OrbFeedback };
