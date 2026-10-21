import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";

const MAX_CLIENT_MESSAGE_BYTES = 512 * 1024;
const COMMAND_TIMEOUT_MS = 8_000;
const ALLOWED_CAPABILITIES = new Set(["music", "companion", "stickers", "appearance"]);

export interface DesktopTrackSummary {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  durationMs?: number;
}

export interface DesktopMusicSnapshot {
  provider: "local" | "qqmusic" | "folia";
  source?: string;
  mode?: string;
  connected: boolean;
  loaded: boolean;
  paused: boolean;
  volume: number;
  positionMs?: number;
  durationMs?: number;
  currentTrackId?: string;
  tracks: DesktopTrackSummary[];
  providerAvailable?: boolean;
  playbackStatus?: string;
  providerCapabilities: string[];
  shuffleAvailable?: boolean;
  playNextAvailable?: boolean;
  playbackMode?: "off" | "all" | "one" | "shuffle";
  playbackModeAvailable?: boolean;
  providerReason?: string;
  updatedAt: number;
}

interface DesktopClient {
  id: string;
  label: string;
  socket: WebSocket;
  capabilities: Set<string>;
  connectedAt: number;
  lastSeenAt: number;
  music?: DesktopMusicSnapshot;
}

/** Queue membership alone is not evidence that a song is currently loaded. */
export function currentMusicTrack(music?: DesktopMusicSnapshot | null): DesktopTrackSummary | null {
  if (!music?.loaded || music.connected === false) return null;
  return music.tracks.find(track => track.id === music.currentTrackId) || null;
}

interface PendingCommand {
  socket: WebSocket;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type ClientEnvelope = {
  __harbour?: unknown;
  clientId?: unknown;
  label?: unknown;
  capabilities?: unknown;
  commandId?: unknown;
  ok?: unknown;
  result?: unknown;
  error?: unknown;
  state?: unknown;
};

function text(value: unknown, max = 120): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function finite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeTrack(value: unknown): DesktopTrackSummary | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = text(row.id, 120);
  const title = text(row.title, 240);
  if (!id || !title) return null;
  return {
    id,
    title,
    ...(text(row.artist, 160) ? { artist: text(row.artist, 160) } : {}),
    ...(text(row.album, 160) ? { album: text(row.album, 160) } : {}),
    ...(finite(row.durationMs, -1) >= 0 ? { durationMs: finite(row.durationMs) } : {}),
  };
}

function normalizeMusicSnapshot(value: unknown, previous?: DesktopMusicSnapshot): DesktopMusicSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const tracks = Array.isArray(row.tracks)
    ? row.tracks.slice(0, 1_000).map(normalizeTrack).filter((track): track is DesktopTrackSummary => !!track)
    : previous?.tracks || [];
  const provider = row.provider === "folia" ? "folia" : row.provider === "qqmusic" ? "qqmusic" : row.provider === "local" ? "local" : previous?.provider || "local";
  const providerCapabilities = Array.isArray(row.providerCapabilities)
    ? row.providerCapabilities.slice(0, 20).map((item) => text(item, 40)).filter(Boolean)
    : previous?.providerCapabilities || [];
  return {
    provider,
    source: text(row.source, 40) || previous?.source,
    mode: text(row.mode, 30) || previous?.mode,
    connected: typeof row.connected === "boolean" ? row.connected : previous?.connected !== false,
    loaded: typeof row.loaded === "boolean" ? row.loaded : previous?.loaded === true,
    paused: typeof row.paused === "boolean" ? row.paused : previous?.paused !== false,
    volume: Math.max(0, Math.min(100, finite(row.volume, previous?.volume ?? 70))),
    positionMs: Math.max(0, finite(row.positionMs, previous?.positionMs ?? 0)),
    durationMs: Math.max(0, finite(row.durationMs, previous?.durationMs ?? 0)),
    ...(text(row.currentTrackId, 120)
      ? { currentTrackId: text(row.currentTrackId, 120) }
      : row.currentTrackId === null || row.currentTrackId === "" ? {} : previous?.currentTrackId ? { currentTrackId: previous.currentTrackId } : {}),
    tracks,
    ...(typeof row.providerAvailable === "boolean" ? { providerAvailable: row.providerAvailable } : previous?.providerAvailable !== undefined ? { providerAvailable: previous.providerAvailable } : {}),
    ...(text(row.playbackStatus, 40) ? { playbackStatus: text(row.playbackStatus, 40) } : previous?.playbackStatus ? { playbackStatus: previous.playbackStatus } : {}),
    providerCapabilities,
    ...(provider === 'folia' && typeof row.shuffleAvailable === 'boolean' ? { shuffleAvailable: row.shuffleAvailable } : {}),
    ...(provider === 'folia' && typeof row.playNextAvailable === 'boolean' ? { playNextAvailable: row.playNextAvailable } : {}),
    ...(provider === 'folia' && typeof row.playbackMode === 'string' && ['off', 'all', 'one', 'shuffle'].includes(row.playbackMode)
      ? { playbackMode: row.playbackMode as DesktopMusicSnapshot['playbackMode'], playbackModeAvailable: row.playbackModeAvailable === true }
      : {}),
    ...(text(row.providerReason, 300) ? { providerReason: text(row.providerReason, 300) } : {}),
    updatedAt: Date.now(),
  };
}

/**
 * Owner-authenticated Electron clients share the existing Harbour WebSocket, but unlike the
 * dashboard they may advertise local-only capabilities such as music playback. This hub keeps
 * those capabilities outside the Agent prompt and offers a narrow request/ack boundary to tools.
 */
export class DesktopClientHub {
  private clients = new Map<WebSocket, DesktopClient>();
  private pending = new Map<string, PendingCommand>();

  attach(socket: WebSocket): () => void {
    const onMessage = (raw: unknown) => this.receive(socket, raw);
    const onClose = () => this.detach(socket);
    socket.on("message", onMessage);
    socket.on("close", onClose);
    socket.on("error", onClose);
    return () => {
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onClose);
      this.detach(socket);
    };
  }

  private receive(socket: WebSocket, raw: unknown): void {
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    if (bytes.byteLength > MAX_CLIENT_MESSAGE_BYTES) return;
    let message: ClientEnvelope;
    try { message = JSON.parse(bytes.toString("utf8")) as ClientEnvelope; } catch { return; }

    if (message.__harbour === "desktop:hello") {
      const clientId = text(message.clientId, 100);
      if (!clientId) return;
      const capabilities = new Set(
        (Array.isArray(message.capabilities) ? message.capabilities : [])
          .map((value) => text(value, 40))
          .filter((value) => ALLOWED_CAPABILITIES.has(value))
      );
      this.clients.set(socket, {
        id: clientId,
        label: text(message.label, 100) || "Harbour Desktop",
        socket,
        capabilities,
        connectedAt: Date.now(),
        lastSeenAt: Date.now(),
      });
      return;
    }

    const client = this.clients.get(socket);
    if (!client) return;
    client.lastSeenAt = Date.now();

    if (message.__harbour === "desktop:state" && client.capabilities.has("music")) {
      const music = normalizeMusicSnapshot(message.state, client.music);
      if (music) client.music = music;
      return;
    }

    if (message.__harbour !== "desktop:command-result") return;
    const commandId = text(message.commandId, 100);
    const pending = this.pending.get(commandId);
    if (!pending || pending.socket !== socket) return;
    clearTimeout(pending.timer);
    this.pending.delete(commandId);
    if (message.ok === false) pending.reject(new Error(text(message.error, 500) || "桌面客户端执行失败"));
    else pending.resolve(message.result ?? { ok: true });
  }

  private detach(socket: WebSocket): void {
    this.clients.delete(socket);
    for (const [id, pending] of this.pending) {
      if (pending.socket !== socket) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error("桌面客户端在执行命令时断开连接"));
      this.pending.delete(id);
    }
  }

  private available(capability: string): DesktopClient[] {
    return [...this.clients.values()].filter(client => client.capabilities.has(capability) && client.socket.readyState === 1);
  }

  private choose(capability: string, clientId?: string): DesktopClient | undefined {
    const clients = this.available(capability);
    const matches = clientId ? clients.filter(client => client.id === clientId) : clients;
    return matches.length === 1 ? matches[0] : undefined;
  }

  musicDevices(summary = false) {
    return this.available("music").map(client => ({ id: client.id, label: client.label,
      music: client.music ? { ...client.music, tracks: (summary
        ? [currentMusicTrack(client.music)].filter((track): track is DesktopTrackSummary => !!track)
        : client.music.tracks).map(track => ({ ...track })) } : null }));
  }

  snapshot(clientId?: string): { connectedClients: number; music: DesktopMusicSnapshot | null; client?: { id: string; label: string } } {
    const client = this.choose("music", clientId);
    return {
      connectedClients: this.clients.size,
      music: client?.music ? { ...client.music, tracks: client.music.tracks.map((track) => ({ ...track })) } : null,
      ...(client ? { client: { id: client.id, label: client.label } } : {}),
    };
  }

  async dispatch(capability: string, command: Record<string, unknown>, signal?: AbortSignal, clientId?: string): Promise<unknown> {
    const client = this.choose(capability, clientId);
    if (!client) throw new Error(clientId ? "指定设备不在线或身份重复；不会改派其它设备" : this.available(capability).length > 1 ? "有多台音乐设备在线，请先选择 deviceId" : `没有在线且支持 ${capability} 的 Harbour Electron 客户端`);
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("运行已取消");
    const commandId = randomUUID();
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId);
        reject(new Error("桌面客户端命令确认超时，结果未知；请先查询状态，不要自动重放"));
      }, capability === "music" ? 65_000 : COMMAND_TIMEOUT_MS);
      this.pending.set(commandId, { socket: client.socket, resolve, reject, timer });
    });
    const onAbort = () => {
      const pending = this.pending.get(commandId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(commandId);
      pending.reject(signal?.reason instanceof Error ? signal.reason : new Error("运行已取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      client.socket.send(JSON.stringify({ __harbour: "companion:command", version: 1, commandId, capability, command }));
      return await result;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

export const desktopClientHub = new DesktopClientHub();
