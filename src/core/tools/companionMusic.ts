import type { ToolDef } from "../../types";
import { desktopClientHub, currentMusicTrack, type DesktopTrackSummary } from "../desktopClientHub";
import { dispatchMusic } from "../musicControl";

type MusicAction = "devices" | "status" | "search" | "queue" | "open" | "play" | "enqueue" | "play_next" | "pause" | "resume" | "stop" | "next" | "previous" | "shuffle" | "set_playback_mode" | "set_volume" | "seek" | "close";

function searchable(track: DesktopTrackSummary): string {
  return `${track.title} ${track.artist || ""} ${track.album || ""}`.toLocaleLowerCase();
}

function searchTracks(query: string, tracks: DesktopTrackSummary[]): DesktopTrackSummary[] {
  const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (!terms.length) return tracks.slice(0, 20);
  return tracks
    .map((track) => ({ track, score: terms.reduce((sum, term) => sum + (searchable(track).includes(term) ? 1 : 0), 0) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.track.title.localeCompare(b.track.title, "zh-CN"))
    .slice(0, 20)
    .map((row) => row.track);
}

/** One compact tool covers local files and an owner-selected desktop provider without exposing paths or account tokens. */
export const companionMusicTool: ToolDef = {
  name: "companion_music",
  description:
    "控制主人选定设备的音乐播放器。Folia 支持 QQ/网易云/酷狗在线搜索、曲库、队列与播放；先 search 再按 trackId 播放。" +
    "多设备用 devices/status 查看并指定 deviceId，不自动换设备。旧 QQ 客户端控制保留兼容。" +
    "工具不读取任意文件、账号、Cookie 或私有音乐接口。" +
    "用于点歌/加入待播、切歌/随机/音量，以及查询‘正在听什么’后聊歌或推荐；status 只提供曲目元数据，不代表听过音频或读过歌词。普通聊天不自动播放或切歌。",
  readOnly: false,
  timeoutMs: 70_000,
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["devices", "status", "search", "queue", "open", "play", "enqueue", "play_next", "pause", "resume", "stop", "next", "previous", "shuffle", "set_playback_mode", "set_volume", "seek", "close"],
        description: "Folia 的 play_next 按 trackId 安排下一首，不中断当前曲目；若原为单曲循环则改为列表循环。enqueue 沿用默认入队偏好。set_playback_mode 切换持续播放模式；旧 shuffle 只打乱一次队列。",
      },
      playbackMode: { type: "string", enum: ["off", "all", "one", "shuffle"], description: "set_playback_mode 必填：off 顺序播放，all 列表循环，one 单曲循环，shuffle 随机播放。" },
      query: { type: "string", description: "search/play 时的歌名、歌手或专辑关键词。" },
      trackId: { type: "string", description: "search/queue 返回的曲目 ID；模型不得编造。" },
      deviceId: { type: "string", description: "devices 返回的执行设备 ID；指定设备离线时不改派。" },
      source: { type: "string", enum: ["qq", "netease", "kugou", "local"] },
      player: { type: "string", enum: ["folia"], description: "显式打开/切换到 Folia；省略则控制设备当前播放器。在线 source 也使用 Folia。" },
      positionMs: { type: "number", minimum: 0, maximum: 86400000 },
      volume: { type: "number", minimum: 0, maximum: 100 },
    },
    required: ["action"],
  },
  async execute(args, ctx) {
    if (ctx.source?.actor?.role !== "owner") throw new Error("音乐陪伴只接受主人会话控制");
    const action = String(args.action || "") as MusicAction;
    const snapshot = desktopClientHub.snapshot(typeof args.deviceId === "string" ? args.deviceId : undefined);
    if (args.action === "devices") return { devices: desktopClientHub.musicDevices(true) };
    if (action === "status") return {
      connectedClients: snapshot.connectedClients,
      devices: desktopClientHub.musicDevices().map(({ id, label }) => ({ id, label })),
      client: snapshot.client,
      music: snapshot.music ? {
        provider: snapshot.music.provider,
        connected: snapshot.music.connected,
        loaded: snapshot.music.loaded,
        paused: snapshot.music.paused,
        volume: snapshot.music.volume,
        positionMs: snapshot.music.positionMs,
        durationMs: snapshot.music.durationMs,
        currentTrackId: snapshot.music.currentTrackId,
        currentTrack: currentMusicTrack(snapshot.music),
        trackCount: snapshot.music.tracks.length,
        providerAvailable: snapshot.music.providerAvailable,
        playbackStatus: snapshot.music.playbackStatus,
        capabilities: snapshot.music.providerCapabilities,
        shuffleAvailable: snapshot.music.shuffleAvailable,
        playNextAvailable: snapshot.music.playNextAvailable,
        playbackMode: snapshot.music.playbackMode,
        playbackModeAvailable: snapshot.music.playbackModeAvailable,
        reason: snapshot.music.providerReason,
        updatedAt: snapshot.music.updatedAt,
        contextScope: "播放器曲目元数据；不含音频或歌词。",
      } : null,
    };
    if (!snapshot.client || !snapshot.music) {
      return { ok: false, devices: desktopClientHub.musicDevices(), reason: "请启动或明确选择在线音乐设备；指定设备离线不会换到另一台。" };
    }
    const provider = snapshot.music.provider || "local";
    if (provider === "folia" || args.player === "folia" || args.source !== undefined) return { provider: "folia", action, result: await dispatchMusic({ ...args, player: "folia", deviceId: snapshot.client.id }, ctx.signal) };
    if (action === "shuffle" || action === "set_playback_mode" || action === "play_next") return { ok: false, provider, reason: "播放模式、下一首播放和随机队列控制目前仅支持 Folia，不自动切换播放器。" };
    if (action === "search") {
      const query = String(args.query || "").trim();
      if (provider === "qqmusic") {
        return {
          ok: false,
          provider,
          query,
          currentTrack: snapshot.music.tracks.find((track) => track.id === snapshot.music?.currentTrackId) || snapshot.music.tracks[0] || null,
          reason: "QQ 音乐未向个人桌面应用开放云曲库搜索 API；请在已登录的 QQ 音乐客户端选歌，之后 Harbour 可继续控制。",
        };
      }
      return { ok: true, query, tracks: searchTracks(query, snapshot.music.tracks) };
    }

    const command: Record<string, unknown> = { action };
    if (action === "play") {
      if (provider === "qqmusic") {
        const current = snapshot.music.tracks.find((track) => track.id === snapshot.music?.currentTrackId) || snapshot.music.tracks[0];
        const trackId = String(args.trackId || "").trim();
        const query = String(args.query || "").trim();
        if (trackId && trackId !== current?.id) {
          return { ok: false, provider, reason: "QQ 音乐只能恢复客户端当前选中的曲目，不能编造或切换云端 trackId。" };
        }
        if (query) {
          const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
          if (!current || !terms.every((term) => searchable(current).includes(term))) {
            return {
              ok: false,
              provider,
              currentTrack: current || null,
              reason: `QQ 音乐当前曲目不是「${query}」；请先在 QQ 音乐客户端选中它，或让我打开 QQ 音乐。`,
            };
          }
        }
      } else {
        let trackId = String(args.trackId || "").trim();
        if (!trackId) {
          const query = String(args.query || "").trim();
          const candidates = searchTracks(query, snapshot.music.tracks);
          const match = candidates[0];
          if (!match) return { ok: false, reason: `本地曲库没有找到「${query}」；请主人先在音乐窗口导入。` };
          trackId = match.id;
          command.matched = match;
        } else if (!snapshot.music.tracks.some((track) => track.id === trackId)) {
          return { ok: false, reason: "trackId 不在当前桌面客户端回报的曲库中；先 search，不能编造 ID。" };
        }
        command.trackId = trackId;
      }
    }
    if (action === "set_volume") {
      if (provider === "qqmusic") {
        return { ok: false, provider, reason: "QQ 音乐 Provider 不接管系统音量；请在 QQ 音乐或 Windows 中调整。" };
      }
      const volume = Number(args.volume);
      if (!Number.isFinite(volume)) return { ok: false, reason: "set_volume 需要 0-100 的 volume" };
      command.volume = Math.max(0, Math.min(100, volume));
    }
    const result = await desktopClientHub.dispatch("music", command, ctx.signal, snapshot.client.id);
    return { ok: true, provider, action, result };
  },
};
