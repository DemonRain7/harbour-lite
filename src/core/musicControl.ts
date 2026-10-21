import { desktopClientHub } from "./desktopClientHub";

// Shared UI/tool validation; commands never accept URLs, paths, scripts or credentials.
export function musicCommand(input: Record<string, unknown>): Record<string, unknown> {
  const action = input.action;
  if (typeof action !== "string" || !["status", "search", "queue", "open", "play", "enqueue", "play_next", "pause", "resume", "stop", "next", "previous", "shuffle", "set_playback_mode", "set_volume", "seek", "close"].includes(action)) throw new Error("不支持的音乐命令");
  const command: Record<string, unknown> = { action };
  if (action === "set_playback_mode") {
    if (typeof input.playbackMode !== "string" || !["off", "all", "one", "shuffle"].includes(input.playbackMode)) throw new Error("playbackMode 无效");
    command.playbackMode = input.playbackMode;
  }
  if (input.player !== undefined) {
    if (input.player !== 'folia') throw new Error('未知播放器');
    command.player = 'folia';
  }
  if (input.source !== undefined) {
    if (!["qq", "netease", "kugou", "local"].includes(String(input.source))) throw new Error("未知音源");
    command.source = input.source;
  }
  for (const [key, max] of [["query", 300], ["trackId", 120]] as const) if (input[key] !== undefined) {
    if (typeof input[key] !== "string" || !input[key].trim() || input[key].length > max) throw new Error(`${key} 无效`);
    command[key] = input[key].trim();
  }
  if (action === "search" && !command.query) throw new Error("搜索需要关键词");
  if (action === "enqueue" && !command.trackId) throw new Error("加入队列需要曲目 ID");
  if (action === "play_next" && !command.trackId) throw new Error("下一首播放需要曲目 ID");
  if (action === "play" && command.query && !command.trackId) throw new Error("先 search，再用返回的 trackId 播放，不能把搜歌当作已播放");
  for (const [key, max] of [["volume", 100], ["positionMs", 86_400_000]] as const) {
    if ((key === "volume" && action === "set_volume") || (key === "positionMs" && action === "seek")) {
      if (typeof input[key] !== "number" || !Number.isFinite(input[key]) || input[key] < 0 || input[key] > max) throw new Error(`${key} 超出范围`);
      command[key] = input[key];
    }
  }
  return command;
}

export function dispatchMusic(input: Record<string, unknown>, signal?: AbortSignal) {
  if (input.deviceId !== undefined && (typeof input.deviceId !== "string" || !input.deviceId.trim() || input.deviceId.length > 100)) throw new Error("deviceId 无效");
  return desktopClientHub.dispatch("music", musicCommand(input), signal, input.deviceId as string | undefined);
}
