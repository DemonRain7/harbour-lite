const { EventEmitter } = require("node:events");

const TERMINAL_PHASES = new Set(["complete", "error", "cancelled"]);
const BUBBLE_LIFETIME_MS = 8_000;

function activityKey(companionId, runId) {
  return `${String(companionId || "").toLowerCase()}\u0000${String(runId || "")}`;
}

function companionIdOf(event) {
  const agent = String(event?.agent || event?.ask?.agent || "");
  const fromAgent = agent.startsWith("main-") ? agent.slice(5).toLowerCase() : "";
  const explicit = event?.companionId ? String(event.companionId).toLowerCase() : "";
  // A malformed shared-bridge event must never make one Main animate another Main's pet.
  if (explicit && fromAgent && explicit !== fromAgent) return "";
  return explicit || fromAgent;
}

function inferMood(text) {
  const value = String(text || "");
  if (/(抱歉|难过|伤心|哭|遗憾|对不起|失败)/u.test(value)) return "sad";
  if (/(担心|小心|注意|危险|别怕|还好吗)/u.test(value)) return "concerned";
  if (/(害羞|脸红|喜欢你|爱你|亲亲|抱抱)/u.test(value)) return "shy";
  if (/(太好|成功|完成|好耶|开心|哈哈|！{2,}|!{2,})/u.test(value)) return "happy";
  if (/(惊喜|居然|竟然|哇|欸)/u.test(value)) return "surprised";
  return "calm";
}

function stateForPhase(phase) {
  if (phase === "incoming") return { status: "incoming", mood: "curious", action: "greet" };
  if (phase === "running") return { status: "working", mood: "focused", action: "work" };
  if (phase === "complete") return { status: "complete", mood: "happy", action: "celebrate" };
  if (phase === "error") return { status: "error", mood: "concerned", action: "worry" };
  if (phase === "cancelled") return { status: "idle", mood: "calm", action: "reset" };
  return { status: "idle", mood: "calm", action: "idle" };
}

class CompanionStateStore extends EventEmitter {
  constructor({ matcher = null } = {}) {
    super();
    this.matcher = matcher;
    this.connection = "connecting";
    this.appearance = { alwaysOnTop: true, category: "anime", persona: "elaina", theme: "anime-wisteria", chatStyle: "flowing", bubbleStyle: "glass", font: "system" };
    this.music = { loaded: false, paused: true, volume: 70, tracks: [] };
    this.characters = new Map();
    this.activities = new Map();
    this.expiryTimers = new Map();
    this.bubbleTimers = new Map();
    this.bubbleSequence = 0;
    this.seenUtterances = new Set();
  }

  character(id) {
    const key = String(id || "").toLowerCase();
    if (!this.characters.has(key)) {
      this.characters.set(key, {
        id: key,
        status: "idle",
        mood: "calm",
        action: "idle",
        bubble: null,
        sticker: null,
        updatedAt: Date.now(),
      });
    }
    return this.characters.get(key);
  }

  setConnection(connection) {
    this.connection = connection;
    this.publish();
  }

  setAppearance(appearance) {
    this.appearance = { ...this.appearance, ...(appearance || {}) };
    this.publish();
  }

  setMusic(music) {
    this.music = { ...this.music, ...(music || {}) };
    this.publish();
  }

  latestActivity(id) {
    return [...this.activities.values()]
      .filter((activity) => activity.companionId === id)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  clearExpiry(id) {
    clearTimeout(this.expiryTimers.get(id));
    this.expiryTimers.delete(id);
  }

  consume(event) {
    if (event?.__harbour === "activity-snapshot") {
      const activeRunIds = new Set(Array.isArray(event.activeRunIds) ? event.activeRunIds.map(String) : []);
      const affected = new Set();
      for (const [key, activity] of this.activities) {
        if (activeRunIds.has(activity.runId)) continue;
        affected.add(activity.companionId);
        this.activities.delete(key);
      }
      for (const id of affected) {
        if (this.latestActivity(id)) continue;
        const state = this.character(id);
        if (["incoming", "working", "thinking"].includes(state.status)) {
          Object.assign(state, stateForPhase("idle"), { updatedAt: Date.now() });
        }
      }
      if (affected.size) this.publish();
      return;
    }
    const id = companionIdOf(event);
    if (event?.__harbour === "channel-activity" && id) {
      const runId = String(event.runId || `${id}:current`);
      const key = activityKey(id, runId);
      const phase = String(event.phase || "");
      this.clearExpiry(id);
      if (TERMINAL_PHASES.has(phase)) this.activities.delete(key);
      else this.activities.set(key, { companionId: id, runId, phase, updatedAt: Date.now() });
      const remaining = this.latestActivity(id);
      Object.assign(this.character(id), stateForPhase(remaining?.phase || phase), { updatedAt: Date.now() });
      if (TERMINAL_PHASES.has(phase) && !remaining) {
        this.scheduleExpiry(id, phase === "error" ? 10_000 : phase === "complete" ? 6_000 : 1_000);
      }
      this.publish();
      return;
    }
    if (event?.__harbour === "ask" && id) {
      const state = this.character(id);
      Object.assign(state, event.kind === "resolved"
        ? { status: "working", mood: "focused", action: "work" }
        : { status: "waiting", mood: "curious", action: "question" }, { updatedAt: Date.now() });
      this.publish();
      return;
    }
    if (event?.__harbour === "companion:utterance" && id) {
      const now = Date.now();
      const createdAt = Math.min(Date.parse(event.createdAt) || now, now);
      const eventKey = event.runId && event.createdAt ? `${id}:${event.runId}:${event.createdAt}` : null;
      if (createdAt + BUBBLE_LIFETIME_MS <= now || (eventKey && this.seenUtterances.has(eventKey))) return;
      if (eventKey) {
        this.seenUtterances.add(eventKey);
        if (this.seenUtterances.size > 128) this.seenUtterances.delete(this.seenUtterances.values().next().value);
      }
      const state = this.character(id);
      const mood = inferMood(event.text);
      const sticker = this.matcher?.(id, event.text, mood) || null;
      Object.assign(state, {
        status: "speaking",
        mood,
        action: mood === "happy" ? "celebrate" : mood === "concerned" || mood === "sad" ? "worry" : "talk",
        bubble: {
          id: `${id}:${++this.bubbleSequence}:${now}`,
          text: String(event.text || "").replace(/\s+/g, " ").slice(0, 160),
          createdAt, expiresAt: createdAt + BUBBLE_LIFETIME_MS,
          runId: event.runId || null, sessionId: event.sessionId || null,
          agentName: event.agent || `main-${id}`, source: event.source || null,
        },
        sticker,
        updatedAt: Date.now(),
      });
      // Notifications have their own deadline. Thinking, asks, music and concurrent
      // tasks must neither cancel it nor invalidate it by changing updatedAt.
      clearTimeout(this.bubbleTimers.get(id));
      const bubbleId = state.bubble.id;
      const timer = setTimeout(() => this.dismissBubble(id, bubbleId), state.bubble.expiresAt - now);
      timer.unref?.();
      this.bubbleTimers.set(id, timer);
      this.publish();
      return;
    }
    if (id && event?.msg === "loop:thinking") {
      const runId = String(event.runId || "");
      const activity = runId ? this.activities.get(activityKey(id, runId)) : this.latestActivity(id);
      if (!activity || activity.companionId !== id) return;
      Object.assign(this.character(id), { status: "thinking", mood: "focused", action: "think", updatedAt: Date.now() });
      this.publish();
    }
  }

  scheduleExpiry(id, delay) {
    this.clearExpiry(id);
    const status = this.character(id).status;
    const timer = setTimeout(() => {
      this.expiryTimers.delete(id);
      const state = this.character(id);
      if (state.status !== status) return;
      const stillRunning = [...this.activities.values()].some((activity) => activity.companionId === id);
      Object.assign(state, {
        status: stillRunning ? "working" : "idle",
        mood: stillRunning ? "focused" : "calm",
        action: stillRunning ? "work" : "idle",
        updatedAt: Date.now(),
      });
      this.publish();
    }, delay);
    timer.unref?.();
    this.expiryTimers.set(id, timer);
  }

  dismissBubble(id, bubbleId) {
    const state = this.characters.get(id);
    // A delayed click/timeout for the preceding reply cannot close the next reply.
    if (!state?.bubble || state.bubble.id !== bubbleId) return false;
    clearTimeout(this.bubbleTimers.get(id));
    this.bubbleTimers.delete(id);
    state.bubble = null;
    state.sticker = null;
    if (state.status === "speaking") Object.assign(state, stateForPhase(this.latestActivity(id)?.phase));
    state.updatedAt = Date.now();
    this.publish();
    return true;
  }

  snapshot() {
    return {
      version: 1,
      connection: this.connection,
      appearance: { ...this.appearance },
      music: { ...this.music, tracks: Array.isArray(this.music.tracks) ? this.music.tracks.map((track) => ({ ...track })) : [] },
      characters: Object.fromEntries([...this.characters].map(([id, state]) => [id, { ...state }])),
      updatedAt: Date.now(),
    };
  }

  publish() {
    this.emit("change", this.snapshot());
  }

  dispose() {
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    for (const timer of this.bubbleTimers.values()) clearTimeout(timer);
    this.bubbleTimers.clear();
    this.removeAllListeners();
  }
}

module.exports = { CompanionStateStore, inferMood, companionIdOf, activityKey, BUBBLE_LIFETIME_MS };
