"use strict";

const activePhases = new Set(["incoming", "running", "stopping"]);
const terminalPhases = new Set(["complete", "error", "cancelled"]);
const short = value => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 120) : "";

// A display-only projection of the existing authenticated WS. No polling,
// submission, cancellation or model call belongs in this class.
class OrbSessionSync {
  constructor(chat) { this.chat = chat; this.active = new Map(); this.finished = new Set(); this.revisions = new Map(); }
  remember(id) {
    this.finished.add(id);
    if (this.finished.size > 128) this.finished.delete(this.finished.values().next().value);
  }
  bind(row) {
    if (row.localRunId) return;
    const event = [...this.active.values()].find(e => e.sessionId === row.sessionId && e.sessionKey === row.key && e.agent === row.agent && e.source?.platform === row.channel);
    if (event) this.follow(row, event);
  }
  follow(row, event) {
    if (row.localRunId || row.sessionId !== event.sessionId) return;
    if (row.external?.runId !== event.runId) {
      row.external = { ...event, baseline: row.messageCount || 0 };
      row.feedback.reset(event.runId, row.sessionId, row.agent);
      row.replyReadyAt = 0; row.asks = []; row.progressTime = event.orbProgress?.time || 0;
    }
    row.runId = event.runId;
    row.phase = event.phase === "stopping" ? "stopping" : row.asks.length ? "waiting" : "running";
    row.detail = event.detail ? short(event.detail) : event.orbProgress?.detail || (row.detail && row.external.hasProgress ? row.detail : "正在完整会话中处理");
    this.overlay(row);
  }
  overlay(row) {
    row.messages = row.messages.filter(m => !m.pendingRunId);
    if (!row.external || row.external.persisted) return;
    row.messages.push({ ...this.chat.message(row, { role: "user", content: row.external.input || row.external.task || "（本轮附件消息）",
      attachments: row.external.attachments }), pendingRunId: row.external.runId });
  }
  consume(event) {
    if (!event || typeof event !== "object") return;
    if (event.__harbour === "activity-snapshot" && Array.isArray(event.activeRunIds)) {
      const live = new Set(event.activeRunIds);
      for (const [id] of this.active) if (!live.has(id)) { this.active.delete(id); this.remember(id); }
      for (const row of this.chat.rows.values()) {
        if (row.localRunId || (!row.loaded && !row.sessionId)) continue;
        if (row.external && !live.has(row.runId)) row.external.terminal = { phase: "reconcile" };
        // Also catches an entire question/reply that happened during an outage.
        this.refresh(row);
      }
      return;
    }
    if (event.__harbour === "channel-activity") {
      if (!this.chat.agents.some(a => a.agentName === event.agent) || typeof event.runId !== "string"
        || !/^[\w.:-]{1,160}$/.test(event.runId)) return;
      if (event.intakeHandoff) {
        // QQ/Discord hand off a short-lived intake ID to the inbox's separate
        // execution ID. Their finally event has no sessionId; recover it only
        // from this exact cached intake, never from the persona's current view.
        const intake = this.active.get(event.runId);
        if (event.phase !== "cancelled" || intake?.phase !== "incoming" || intake.agent !== event.agent
          || event.sessionKey !== intake.sessionKey || event.source?.platform !== intake.source?.platform
          || event.sessionId !== undefined && event.sessionId !== intake.sessionId) return;
        event = { ...event, sessionId: intake.sessionId };
      }
      if (typeof event.sessionId !== "string") return;
      const row = this.chat.row(event.agent);
      // Cache all of this persona's runs before a history selection, but bind
      // only the exact chosen session/key/channel. Channel mirrors stay read-only.
      if (typeof event.sessionKey !== "string" || !event.source?.platform) return;
      if (!activePhases.has(event.phase) && !terminalPhases.has(event.phase)) return;
      this.revisions.set(event.sessionId, (this.revisions.get(event.sessionId) || 0) + 1);
      if (this.revisions.size > 128) this.revisions.delete(this.revisions.keys().next().value);
      if (activePhases.has(event.phase)) {
        if (this.finished.has(event.runId)) return;
        // Receiving another input is not starting a replacement execution. In
        // particular, a steer can join the current run without ever getting its
        // own running/complete events. Keep following the formal run and trace.
        if (event.phase === "incoming" && [...this.active.values()].some(e => e.phase !== "incoming"
          && e.sessionId === event.sessionId && e.sessionKey === event.sessionKey
          && e.agent === event.agent && e.source?.platform === event.source.platform)) return;
        const previous = [...this.active.values()].find(e => e.sessionId === event.sessionId && e.sessionKey === event.sessionKey && e.runId !== event.runId);
        if (previous && Number(event.startedAt) < Number(previous.startedAt)) return;
        if (previous) { this.active.delete(previous.runId); this.remember(previous.runId); }
        this.active.set(event.runId, { ...event, orbProgress: this.active.get(event.runId)?.orbProgress });
        if (this.active.size > 128) this.active.delete(this.active.keys().next().value);
        if (row.sessionId !== event.sessionId || row.key !== event.sessionKey || row.channel !== event.source.platform || row.localRunId || row.changing) return;
        // A replayed older run cannot replace the current newer task.
        if (row.external && row.external.runId !== event.runId && Number(event.startedAt) < Number(row.external.startedAt)) return;
        const newRun = row.external?.runId !== event.runId;
        this.follow(row, event); this.chat.changed(row);
        if (newRun) this.refresh(row);
      } else if (terminalPhases.has(event.phase)) {
        this.active.delete(event.runId); this.remember(event.runId);
        if (row.localRunId || row.sessionId !== event.sessionId || row.key !== event.sessionKey || row.channel !== event.source.platform || row.changing) return;
        if (event.intakeHandoff) {
          if (row.external?.runId === event.runId) {
            row.runId = null; row.external = null; row.asks = [];
            row.phase = "idle"; row.detail = "消息已接收，等待完整会话处理";
            row.feedback.reset(); this.overlay(row); this.chat.changed(row);
          }
          // Handoff is not a cancelled/completed model run. Refresh only the
          // saved conversation; a later running event owns actual execution.
          this.refresh(row); return;
        }
        if (!row.external) {
          // A very short run may finish while the initial session read is pending.
          // Reload its record, but do not replay the task or fabricate a question.
          this.refresh(row); return;
        }
        if (row.external.runId !== event.runId) return;
        row.external.terminal = event;
        row.detail = "正在同步会话…";
        this.chat.changed(row); this.refresh(row);
      }
      return;
    }
    const cached = this.active.get(event.runId);
    if (cached && (!event.sessionId || event.sessionId === cached.sessionId)) {
      const detail = progressDetail(event, cached.agent), time = Number(event.time);
      if (detail && (!Number.isFinite(time) || time >= (cached.orbProgress?.time || 0))) {
        cached.orbProgress = { detail: detail.slice(0, 140), time: Number.isFinite(time) ? time : cached.orbProgress?.time || 0 };
      }
    }
    for (const row of this.chat.rows.values()) {
      if (!row.runId || row.runId !== event.runId || (event.sessionId && event.sessionId !== row.sessionId)
        || row.external?.terminal || row.phase === "stopping") continue;
      const detail = progressDetail(event, row.agent);
      const time = Number(event.time);
      if (!detail || (Number.isFinite(time) && time < (row.progressTime || 0))) continue;
      if (Number.isFinite(time)) row.progressTime = time;
      if (row.external) row.external.hasProgress = true;
      if (row.detail !== detail.slice(0, 140)) { row.detail = detail.slice(0, 140); this.chat.changed(row); }
    }
  }
  refresh(row) {
    if (this.chat.disposed || !row.sessionId || row.localRunId || row.changing) return Promise.resolve();
    // Coalesce lifecycle/reconnect reads, never read history for each trace step.
    row.syncAgain = true;
    if (row.syncing) return row.syncing;
    row.syncing = (async () => {
      while (row.syncAgain && !this.chat.disposed) {
        row.syncAgain = false;
        const id = row.sessionId, external = row.external, terminal = external?.terminal;
        const url = this.chat.getConfig().url;
        const stillCurrent = () => !this.chat.disposed && row.sessionId === id && row.external === external
          && external?.terminal === terminal && !row.localRunId && !row.changing && this.chat.getConfig().url === url;
        try {
          const { session } = await this.chat.readSession(id);
          if (!stillCurrent()) continue;
          this.chat.assertSession(row, session);
          if (session.id !== id) throw new Error("会话编号不匹配");
          const lastBefore = JSON.stringify(row.messages.filter(m => !m.pendingRunId).at(-1));
          const record = external && session.messages?.find(m => m.role === "assistant" && m.runRecord?.attemptId === external.runId)?.runRecord;
          this.chat.acceptSession(row, session);
          row.syncError = "";
          if (external) {
            external.persisted = !!record;
            if (terminal) {
              row.runId = null; row.external = null; row.asks = [];
              if (terminal.phase === "cancelled") {
                row.phase = "cancelled"; row.detail = "已停止，断点保留"; row.feedback.cancel();
              } else if (terminal.phase === "error") {
                row.phase = "idle"; row.detail = short(terminal.detail) || "本轮执行失败";
              } else if (record?.status === "answered" || (!record && terminal.phase === "complete"
                && session.messages?.length > external.baseline && session.messages.at(-1)?.role === "assistant")) {
                row.phase = "complete"; row.detail = "已回复"; row.replyReadyAt = Date.now();
              } else if (record?.status === "interrupted") {
                row.phase = "cancelled"; row.detail = "本轮已中断，请在完整会话查看断点";
              } else {
                row.phase = "uncertain"; row.detail = "任务已不在运行，结果尚未确认，请打开完整会话核对";
              }
            } else this.overlay(row);
          } else {
            const confirmed = row.phase === "uncertain" && session.messages?.some(m => m.runRecord?.attemptId === row.feedback.runId && m.runRecord?.status === "answered");
            if (confirmed || (row.phase !== "uncertain" && lastBefore !== JSON.stringify(row.messages.at(-1)) && row.messages.at(-1)?.role === "assistant")) {
              if (session.messages.at(-1)?.runRecord?.status === "interrupted") {
                row.phase = "cancelled"; row.detail = "本轮已中断，请在完整会话查看断点";
              } else {
                row.phase = "complete"; row.detail = "会话已同步"; row.replyReadyAt = Date.now();
              }
            }
          }
          this.chat.changed(row);
        } catch {
          if (stillCurrent()) {
            row.syncError = row.detail = "暂时无法同步，请重新打开悬浮助手或查看完整会话";
            this.chat.changed(row);
          }
        }
      }
    })().finally(() => { row.syncing = null; if (!this.chat.disposed) this.chat.changed(row); });
    this.chat.changed(row);
    return row.syncing;
  }
}

function progressDetail(event, agent) {
  const child = event.agent && event.agent !== agent ? `${short(event.agent)} · ` : "";
  switch (event.msg) {
    case "loop:start": return `${child}开始处理`;
    case "loop:thinking": return `${child}思考中…`;
    case "loop:tool-calls": return Array.isArray(event.calls) && event.calls.includes("ask_user") ? "正在完整会话中等你确认"
      : `${child}正在执行 · ${(Array.isArray(event.calls) ? event.calls : []).filter(v => typeof v === "string").slice(0, 3).map(short).join("、") || "工具"}`;
    case "loop:tool-result": return `${child}收到 ${short(event.tool) || "工具"} 回执`;
    case "spawn_subagent": return `已交给 ${short(event.to) || "子任务"} 处理`;
    case "skill:loaded": return `已读取 ${short(event.skill) || "技能"}`;
    case "workflow:start": return `正在执行 ${short(event.workflow) || "工作流"}`;
    case "workflow:progress": return `${short(event.workflow) || "工作流"} · ${Number.isFinite(event.completed) && Number.isFinite(event.total) ? `${event.completed}/${event.total}` : short(event.status) || "处理中"}`;
    case "progress:updated": {
      const steps = Array.isArray(event.progress?.steps) ? event.progress.steps.filter(s => s && typeof s === "object") : [];
      const current = steps.find(s => s.status === "in_progress" || s.status === "blocked");
      return steps.length ? `${steps.filter(s => s.status === "completed").length}/${steps.length} · ${short(current?.title || event.progress.title)}` : "";
    }
    case "loop:final": return `${child}正在整理回复`;
    case "loop:end": return event.agent !== agent && event.status === "completed" ? `${child}已完成，主任务继续处理` : "";
    default: return "";
  }
}

module.exports = { OrbSessionSync, progressDetail };
