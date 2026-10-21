"use strict";

const { EventEmitter } = require("node:events");
const { progressDetail } = require("./orb-session-sync");
const { conversationTarget } = require("./conversation-link");
const { revision, rememberReceipt } = require("./orb-read-state");
const text = (value, limit = 160) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
const live = new Set(["incoming", "running", "stopping"]);
const terminal = new Set(["complete", "error", "cancelled"]);
const validId = value => typeof value === "string" && /^[\w.:-]{1,160}$/.test(value);

function musicSignal(value = {}) {
  // Use the selected local provider's confirmed track, never the queue head or
  // metadata on another device. Position/volume changes don't repaint the orb.
  if (!value || value.loaded !== true || typeof value.currentTrackId !== "string" || !value.currentTrackId
    || value.connected === false || value.running === false
    || value.providerAvailable === false) return null;
  const track = Array.isArray(value.tracks) ? value.tracks.find(row => row?.id === value.currentTrackId) : null;
  if (!text(track?.title)) return null;
  return { title: text(track.title), artist: text(track.artist, 80), paused: value.paused !== false,
    provider: ["folia", "local", "qqmusic"].includes(value.provider) ? value.provider : "local" };
}

function sourceLabel(source = {}) {
  const platform = { web: "Web", qq: "QQ", discord: "Discord", cron: "定时任务" }[source.platform] || "Harbour";
  return [platform, text(source.locationName || source.containerName || source.accountLabel, 60)].filter(Boolean).join(" · ");
}

// Display only, shared authenticated bridge input. No history fetch, model,
// polling, player process, task submission or cancellation lives here.
class OrbSignals extends EventEmitter {
  constructor({ agents = [] } = {}) {
    super(); this.agents = new Set(agents); this.tasks = new Map(); this.finished = new Set(); this.music = null;
    this.readReplies = new Map();
  }
  setMusic(value) {
    const next = musicSignal(value);
    if (JSON.stringify(next) === JSON.stringify(this.music)) return;
    this.music = next; this.emit("change");
  }
  remember(id) {
    this.finished.add(id);
    if (this.finished.size > 512) this.finished.delete(this.finished.values().next().value);
  }
  consume(event) {
    if (!event || typeof event !== "object") return;
    if (event.__harbour === "session-read") {
      if (!rememberReceipt(this.readReplies, event)) return;
      let changed = false;
      for (const row of this.tasks.values()) if (this.isRead(row)) {
        this.tasks.delete(row.runId); changed = true;
      }
      if (changed) this.emit("change");
      return;
    }
    if (event.__harbour === "activity-snapshot" && Array.isArray(event.activeRunIds)) {
      const ids = new Set(event.activeRunIds); let changed = false;
      for (const row of this.tasks.values()) if (live.has(row.phase)) {
        // A resolved ask may have been missed while disconnected. The active
        // snapshot does not certify old asks are still waiting; only a new ask can.
        if (row.asks.size) { row.asks.clear(); changed = true; }
        if (!ids.has(row.runId)) {
          // Disappearing from the active set is not proof of completion.
          row.phase = "unknown"; row.detail = "任务已不在运行，结果待核对";
          this.remember(row.runId); changed = true;
        }
      }
      if (changed) this.emit("change");
      return;
    }
    if (event.__harbour === "channel-activity") {
      if (!this.agents.has(event.agent) || !validId(event.runId)
        || event.companionId && event.agent !== `main-${event.companionId}`
        || !live.has(event.phase) && !terminal.has(event.phase)) return;
      const previous = this.tasks.get(event.runId);
      if (previous && previous.agent !== event.agent) return;
      // Duplicate/replayed terminal events must not replace a confirmed failure
      // or recreate a notification already opened by the user.
      if (previous && terminal.has(previous.phase)) return;
      if (live.has(event.phase) && this.finished.has(event.runId)) return;
      if (terminal.has(event.phase) && this.finished.has(event.runId) && !previous) return;
      if (event.intakeHandoff || event.phase === "cancelled") {
        this.tasks.delete(event.runId); this.remember(event.runId); this.emit("change"); return;
      }
      const row = { ...previous, agent: event.agent, runId: event.runId, phase: event.phase,
        sessionId: conversationTarget({ sessionId: event.sessionId || previous?.sessionId, agentName: event.agent })?.sessionId || "",
        sessionKey: text(event.sessionKey || previous?.sessionKey, 240),
        replyRevision: terminal.has(event.phase) && revision(event.replyRevision) && event.replyRevision > 0 ? event.replyRevision : null,
        title: text(event.task) || previous?.title || "当前任务",
        detail: text(event.detail) || previous?.detail || "正在处理",
        source: event.source ? sourceLabel(event.source) : previous?.source || "Harbour",
        updatedAt: Date.now(), asks: terminal.has(event.phase) ? new Map() : previous?.asks || new Map() };
      if (terminal.has(event.phase)) { this.remember(event.runId); row.detail = text(event.detail) || ""; }
      if (terminal.has(event.phase)) rememberReceipt(this.readReplies, { ...event, id: row.sessionId });
      if (this.isRead(row)) {
        this.tasks.delete(row.runId); this.emit("change"); return;
      }
      this.tasks.set(event.runId, row);
      if (this.tasks.size > 128) {
        const oldest = [...this.tasks.values()].sort((a, b) => Number(live.has(a.phase)) - Number(live.has(b.phase)) || a.updatedAt - b.updatedAt)[0];
        this.tasks.delete(oldest.runId);
      }
      this.emit("change"); return;
    }
    if (event.__harbour === "ask" && event.ask) {
      const ask = event.ask;
      const rows = [...this.tasks.values()].filter(row => live.has(row.phase)
        && (ask.runId ? row.runId === ask.runId : ask.sessionKey && row.sessionKey === ask.sessionKey)
        && (!this.agents.has(ask.agent) || row.agent === ask.agent));
      if (rows.length !== 1 || !validId(ask.id) || !["new", "resolved"].includes(event.kind)) return;
      const row = rows[0];
      if (event.kind === "resolved") { if (!row.asks.delete(ask.id)) return; }
      else {
        const expires = Date.parse(ask.expiresAt);
        if (!Number.isFinite(expires) || expires <= Date.now()) return;
        if (row.asks.size >= 8 || row.asks.has(ask.id)) return;
        row.asks.set(ask.id, expires);
      }
      this.emit("change"); return;
    }
    const row = this.tasks.get(event.runId);
    if (!row || !live.has(row.phase) || event.sessionId && row.sessionId && event.sessionId !== row.sessionId) return;
    const at = Number(event.time);
    if (Number.isFinite(at) && at < (row.progressAt || 0)) return;
    const detail = text(progressDetail(event, row.agent));
    if (!detail || detail === row.detail) return;
    row.detail = detail; row.updatedAt = Date.now();
    if (Number.isFinite(at)) row.progressAt = at;
    this.emit("change");
  }
  isRead(row) {
    const known = this.readReplies.get(row.sessionId);
    return !live.has(row.phase) && known && (row.replyRevision > 0 && known.readReplyRevision >= row.replyRevision
      || known.replyRevision > 0 && known.readReplyRevision === known.replyRevision && known.replyRunId === row.runId);
  }
  snapshot(agent, connection = "open") {
    const rows = [...this.tasks.values()].filter(row => row.agent === agent);
    const active = rows.filter(row => live.has(row.phase));
    const waiting = row => [...row.asks.values()].some(expires => expires > Date.now());
    const rank = row => waiting(row) ? 0 : live.has(row.phase) ? 1 : row.phase === "error" ? 2 : row.phase === "unknown" ? 3 : 4;
    const row = rows.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)[0];
    const stale = row && live.has(row.phase) && connection !== "open";
    const kind = !row ? "idle" : stale || row.phase === "unknown" ? "unknown" : waiting(row) ? "waiting"
      : live.has(row.phase) ? "working" : row.phase === "error" ? "failed" : "reply";
    const label = { idle: "在你身边", unknown: "任务状态待核对", waiting: "等你确认", working: "正在处理", failed: "遇到问题", reply: "回复已就绪" }[kind];
    const notification = rows.some(item => item.phase === "error") ? "failed" : rows.some(item => item.phase === "complete") ? "reply" : "none";
    return { task: row ? { runId: row.runId, sessionId: row.sessionId, kind, label, title: row.title,
      detail: stale ? "连接中断，暂时无法确认任务进度" : row.detail, source: row.source, count: active.length,
      canOpen: !!row.sessionId } : null, notification, music: this.music ? { ...this.music } : null };
  }
  acknowledge(agent, runId) {
    const row = this.tasks.get(runId);
    if (!row || row.agent !== agent || live.has(row.phase)) return;
    this.tasks.delete(runId); this.emit("change");
  }
  acknowledgeSession(agent, sessionId, replyRevision) {
    let changed = false;
    for (const row of this.tasks.values()) if (row.agent === agent && row.sessionId === sessionId && terminal.has(row.phase)
      && (!revision(row.replyRevision) || revision(replyRevision) && row.replyRevision <= replyRevision)) {
      this.tasks.delete(row.runId); changed = true;
    }
    if (changed) this.emit("change");
  }
}

module.exports = { OrbSignals, musicSignal, sourceLabel };
