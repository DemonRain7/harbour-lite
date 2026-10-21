import type { WebSocket } from "ws";
import { logTimeFields, type ExtraSink } from "../core/logger";

/**
 * 日志广播器：作为 logger 的 ExtraSink 接收每一行 JSON 日志，
 * 缓存最近 N 行（新客户端连上时回放），并实时推给所有 WS 客户端。
 * 前端 dashboard 的「实时终端」就是订阅它。
 */
export class LogBroadcaster implements ExtraSink {
  private clients = new Set<WebSocket>();
  private ring: string[] = [];
  private runTraces = new Map<string, Record<string, unknown>[]>();
  private activeActivities = new Map<string, string>();
  /** 前端用它识别 Harbour 是否重启过，清掉旧进程遗留的幽灵运行。 */
  private readonly serverEpoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  constructor(private maxBuffer = 400) {}

  write(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (this.runTraces.size) this.captureRunTrace(trimmed);
    this.ring.push(trimmed);
    if (this.ring.length > this.maxBuffer) this.ring.shift();
    for (const ws of this.clients) {
      try {
        ws.send(trimmed);
      } catch {
        /* 单个客户端发送失败忽略 */
      }
    }
  }

  /** 开始收集某一顶层 run 的展示轨迹。日志必须带同一个 runId 才会进入。 */
  beginRunTrace(runId: string): void {
    // 渠道语音会在进入 worker 队列前先跑 STT；此时已经开始收集 trace。
    // worker 接手后再次 begin 不能把前置的 STT 事件清空。
    if (runId && !this.runTraces.has(runId)) this.runTraces.set(runId, []);
  }

  /** 把模型 loop 之前产生的结构化事件（如 STT）挂到同一个 run，并实时广播给前端。 */
  recordRunTraceEvent(runId: string, event: Record<string, unknown>): void {
    if (!runId || !this.runTraces.has(runId)) return;
    this.write(JSON.stringify({ level: 30, runId, ...event, ...logTimeFields() }));
  }

  /** 结束并取走轨迹；调用后立即释放内存。 */
  finishRunTrace(runId: string): Record<string, unknown>[] {
    const trace = this.runTraces.get(runId) ?? [];
    this.runTraces.delete(runId);
    return trace;
  }

  discardRunTrace(runId: string): void {
    this.runTraces.delete(runId);
  }

  activeRunCount(): number { return this.activeActivities.size; }

  /** Includes queued work and channel delivery after the model lease ends. */
  hasActiveSession(sessionId: string): boolean {
    return [...this.activeActivities.values()].some(line => JSON.parse(line).sessionId === sessionId);
  }

  private captureRunTrace(line: string): void {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const runId = typeof parsed.runId === "string" ? parsed.runId : "";
    const target = this.runTraces.get(runId);
    if (!target) return;
    const msg = typeof parsed.msg === "string" ? parsed.msg : "";
    if (!(msg.startsWith("loop:") || msg.startsWith("stt:") || msg.startsWith("vision:") || msg === "skill:loaded" || msg === "spawn_subagent"
      || msg === "plan:submitted" || msg === "progress:updated" || /^workflow:(loaded|start|result|progress|error)$/.test(msg))) return;
    // 保留机器时间及可读副本，供历史 Trace 按 Settings 展示；pid/hostname 不落 session。
    const allowed = [
      "time", "timeLocal", "timeZone",
      "msg", "agent", "step", "injectedTokens", "trimmedTokens", "calls", "tool", "resultPreview",
      "preview", "modelRef", "tools", "answerPreview", "from", "to", "isLast", "err", "before",
      "after", "dropped", "kept", "skill", "resource", "maxTurns", "modelSteps", "stepLimit", "segments", "maxSegments",
      "source", "provider", "processingMs", "audioDurationMs", "attachment",
      "images", "bytes", "width", "height", "normalized",
      "attempt", "maxRetries", "retryDelayMs", "errorStatus", "error",
      "transport", "fromTransport", "toTransport",
      "reason", "aborted",
      "traceId", "parentTraceId", "status", "workflow", "action", "completed", "total", "jobId",
    ];
    const event: Record<string, unknown> = {};
    for (const key of allowed) if (key in parsed) event[key] = parsed[key];
    // Only structured display events may carry a plan; never generic tool result/input blobs.
    if (msg === "plan:submitted") event.plan = parsed.plan;
    if (msg === "progress:updated") event.progress = parsed.progress;
    const anchor = traceAnchor(event);
    if (anchor) {
      const prior = target.findIndex(item => traceAnchor(item) === anchor);
      if (prior >= 0) target.splice(prior, 1);
    }
    target.push(event);
    if (target.length > 400) {
      const disposable = target.findIndex(item => !traceAnchor(item));
      target.splice(disposable < 0 ? 0 : disposable, 1);
    }
  }

  /**
   * 推一条【非日志】的结构化事件（目前只有 askUser 提问/结算）。
   * 刻意不进 ring：ask 是有时效的，回放旧提问只会让前端弹出早就过期的框；
   * 前端连上后自己拉一次 GET /api/asks 补齐当前待答项。
   */
  pushEvent(payload: unknown): void {
    let line: string;
    try { line = JSON.stringify(payload); } catch { return; }
    const event = payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
    if (event?.__harbour === "channel-activity" && typeof event.runId === "string") {
      const phase = String(event.phase ?? "");
      if (phase === "complete" || phase === "error" || phase === "cancelled") {
        this.activeActivities.delete(event.runId);
      } else {
        this.activeActivities.set(event.runId, line);
      }
    }
    for (const ws of this.clients) {
      try { ws.send(line); } catch { /* 单个客户端失败忽略 */ }
    }
  }

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    // 先告诉新客户端当前有哪些渠道 run，再回放 ring 中已经发生的相关 loop 日志；
    // 否则日志先到、前端还不知道 runId 属于哪个 session，会把它们当成无关并发丢掉。
    for (const line of this.activeActivities.values()) {
      try { ws.send(line); } catch { break; }
    }
    // 终态事件刻意不进 ring（否则重放一堆历史 complete/error）；因此单独发一份权威活跃集合。
    // 客户端拿它删除断线期间错过终态的 stale run，避免计时器永远增长。
    try {
      ws.send(JSON.stringify({
        __harbour: "activity-snapshot",
        serverEpoch: this.serverEpoch,
        activeRunIds: [...this.activeActivities.keys()],
        at: Date.now(),
      }));
    } catch { /* 下面 ring 也会自然失败 */ }
    // Long runs may outlive the ring. Seed current plans/lane identities before replay;
    // revisions and per-loop terminal states make older ring events harmless.
    for (const [runId, events] of this.runTraces) {
      if (!this.activeActivities.has(runId)) continue;
      for (const event of events.filter(item => traceAnchor(item))) {
        try { ws.send(JSON.stringify({ ...event, runId })); } catch { break; }
      }
    }
    // 回放最近缓冲，让刚连上的前端立刻有上下文。
    for (const line of this.ring) {
      try {
        ws.send(line);
      } catch {
        break;
      }
    }
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));
  }
}

function traceAnchor(event: Record<string, unknown>): string | undefined {
  if (event.msg === "progress:updated") {
    const id = (event.progress as { id?: unknown } | undefined)?.id;
    return typeof id === "string" ? `progress:${id}` : undefined;
  }
  if (event.msg === "plan:submitted") return `plan:${(event.plan as { id?: string } | undefined)?.id || event.traceId || event.agent}`;
  if (event.traceId && (event.msg === "loop:start" || event.msg === "loop:end")) return `${event.msg}:${event.traceId}`;
  return undefined;
}
