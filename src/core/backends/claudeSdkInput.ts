import { randomUUID } from "node:crypto";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RunInput, SteerResult } from "../runInputs";

type Entry = {
  message: SDKUserMessage;
  input: RunInput;
  taken: boolean;
  resolve: (result: SteerResult) => void;
};

/** One persistent stdin stream per query. Never end/reopen input for each supplement. */
export class ClaudeSdkInput {
  private queue: Entry[] = [];
  private receipts = new Map<string, Entry>();
  private wake?: () => void;
  private accepting = true;
  private closed = false;
  submitted = false;

  constructor(private initial: string | AsyncIterable<SDKUserMessage>,
    private prepare: (input: RunInput) => Promise<SDKUserMessage | undefined>,
    private accepted: (input: RunInput, uuid: string) => void) {}

  get awaitingReceipt(): boolean { return this.receipts.size > 0; }

  async *stream(): AsyncGenerator<SDKUserMessage> {
    try {
      if (this.closed) return;
      if (typeof this.initial === "string") yield userMessage(this.initial);
      else yield* this.initial;
      while (!this.closed) {
        if (!this.queue.length) await new Promise<void>(resolve => { this.wake = resolve; });
        this.wake = undefined;
        while (!this.closed && this.queue.length) {
          const entry = this.queue.shift()!;
          // SDK is about to write the message. A later pipe failure is unknown, not safe to resend.
          entry.taken = true;
          this.submitted = true;
          yield entry.message;
        }
      }
    } finally { this.close(); }
  }

  async send(input: RunInput): Promise<SteerResult> {
    if (!this.accepting || this.closed) return "unavailable";
    let message: SDKUserMessage | undefined;
    try { message = await this.prepare(input); } catch { return "unavailable"; }
    if (!message || !this.accepting || this.closed) return "unavailable";
    const uuid = randomUUID();
    return new Promise<SteerResult>(resolve => {
      const entry: Entry = { input, taken: false, resolve,
        message: { ...message, uuid, priority: "next" } };
      this.receipts.set(uuid, entry);
      this.queue.push(entry);
      this.wake?.();
    });
  }

  /** Only our exact UUID echo is acceptance. Historic replay/tool results are not receipts. */
  acknowledge(uuid: string | undefined): boolean {
    const entry = uuid ? this.receipts.get(uuid) : undefined;
    if (!entry || !entry.taken) return false;
    this.accepted(entry.input, uuid!);
    this.receipts.delete(uuid!);
    entry.resolve("accepted");
    return true;
  }

  /** A deliverable terminal result closes admission; a superseded result keeps the query active. */
  stopAccepting(): void { this.accepting = false; }

  close(): void {
    this.stopAccepting(); this.closed = true;
    for (const entry of this.receipts.values()) entry.resolve(entry.taken ? "unknown" : "unavailable");
    this.receipts.clear(); this.queue = []; this.wake?.();
  }
}

export function userMessage(content: string): SDKUserMessage {
  return { type: "user", uuid: randomUUID(), parent_tool_use_id: null, message: { role: "user", content } };
}
