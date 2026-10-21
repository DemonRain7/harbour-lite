import { Writable } from "node:stream";
import pino, { type Logger } from "pino";
import pretty from "pino-pretty";
import { formatZonedIso, getHarbourTimeZone } from "./timeZone";

/** 额外的日志去处（如把日志分流到前端 WebSocket）。收到的是 JSON 行。 */
export interface ExtraSink {
  write(line: string): void;
}

/** Machine time stays epoch milliseconds; readable fields follow the current Settings zone. */
export function logTimeFields(time = Date.now()): { time: number; timeLocal: string; timeZone: string } {
  const timeZone = getHarbourTimeZone();
  return { time, timeLocal: formatZonedIso(time, timeZone), timeZone };
}

export interface LoggerOutputOptions {
  /** Optional destination/TTY override for embedding and deterministic offline tests. */
  stream?: pino.DestinationStream;
  pretty?: boolean;
  colorize?: boolean;
}

/**
 * 全局日志。
 * - 终端（TTY）：pino-pretty 彩色易读；非 TTY：原始 JSON 行。
 * - 若传入 extra（如 LogBroadcaster），用 multistream 把同一份 JSON 日志同时
 *   喂给它——前端 dashboard 的实时终端就是这么拿到 loop 事件的。
 */
export function makeLogger(level = "info", extra?: ExtraSink, output: LoggerOutputOptions = {}): Logger {
  const destination = output.stream ?? process.stdout;
  const streams: pino.StreamEntry[] = [
    (output.pretty ?? process.stdout.isTTY)
      ? { stream: pretty({ colorize: output.colorize ?? true, timestampKey: "timeLocal", translateTime: false,
        ignore: "pid,hostname,time,timeZone", destination }) }
      : { stream: destination },
  ];

  if (extra) {
    /*
     * 行分帧：绝不能假设「一次 write = 一整行 JSON」。
     * 大日志行（如 orchestrator 提交的结构化执行计划，几 KB）会被流拆成多个 chunk，
     * 直接 toString() 转发就是半截 JSON —— 前端 JSON.parse 失败后静默丢弃，
     * 表现为「这条日志在 dashboard 里根本不出现」（实测 plan:submitted 就这么丢的）。
     * 反过来一个 chunk 里也可能塞着好几行。所以按 \n 缓冲切分，只转发完整行。
     */
    let pending = "";
    const sink = new Writable({
      write(chunk, _enc, cb) {
        try {
          pending += chunk.toString();
          const lines = pending.split("\n");
          pending = lines.pop() ?? ""; // 最后一段可能不完整，留到下次
          for (const line of lines) {
            const t = line.trim();
            if (t) extra.write(t);
          }
        } catch {
          /* 分流失败不影响主日志 */
        }
        cb();
      },
    });
    streams.push({ stream: sink });
  }

  return pino({ level, timestamp: () => `,${JSON.stringify(logTimeFields()).slice(1, -1)}` }, pino.multistream(streams));
}

export type { Logger };
