/** Live cancellation handles, never reconstructed from chat history or an agent name.
 * A lease covers execution only; completed output may still be sending to the channel.
 * Queued/STT tasks do not advertise a stop handle until their worker has started. */
export class ChannelRunControl {
  private runs = new Map<string, {
    sessionId: string;
    stopping: boolean;
    stop: () => void;
    onStopping: () => void;
  }>();

  register(runId: string, sessionId: string, stop: () => void, onStopping: () => void) {
    if (!runId || !sessionId || this.runs.has(runId)) throw new Error("Invalid or duplicate channel run lease");
    const run = { sessionId, stopping: false, stop, onStopping };
    this.runs.set(runId, run);
    return () => { if (this.runs.get(runId) === run) this.runs.delete(runId); };
  }

  canStop(runId: string) { return this.runs.has(runId); }
  stopSession(sessionId: string, beforeStop: () => void = () => {}): void {
    for (const [runId, run] of this.runs) if (run.sessionId === sessionId) this.stop(runId, sessionId, beforeStop);
  }

  /** Synchronous lookup + goal pause + abort: no await at which a newer run can take over. */
  stop(runId: string, sessionId: string, beforeStop: () => void): "stopping" | "not_active" | "session_mismatch" {
    const run = this.runs.get(runId);
    if (!run) return "not_active";
    if (run.sessionId !== sessionId) return "session_mismatch";
    if (!run.stopping) {
      beforeStop();
      run.stopping = true;
      run.stop();
      run.onStopping();
    }
    return "stopping";
  }
}
