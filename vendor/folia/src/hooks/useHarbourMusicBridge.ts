import { useEffect, useRef } from 'react';
import type { SongResult, LocalSong, StageLoopMode } from '../types';
import { buildUnifiedLocalSong } from '../services/playbackAdapters';
import { PlayerState } from '../types';
import { omni } from '../services/onlineMusic/omni';
import { usePlaybackStore } from '../stores/usePlaybackStore';
import { useAudioSettingsStore } from '../stores/useAudioSettingsStore';
import { useOnlineProviderAccountStore } from '../stores/useOnlineProviderAccountStore';
import { getPlaybackSongKey } from '../utils/appPlaybackGuards';
import { createAudioPlaybackHealth } from '../services/audioPlaybackHealth';
import { useStatusMessageStore } from '../stores/useStatusMessageStore';
import i18n from '../i18n/config';
import { createHarbourLyrics } from '../utils/harbourLyrics';

// Transport adapter only: all loading, queue and provider behavior stays in Folia.
declare global {
  interface Window {
    harbourFolia?: {
      ready(): Promise<unknown>;
      getPresentation?(): Promise<'embedded' | 'window' | 'background'>;
      onPresentationChanged?(handler: (mode: 'embedded' | 'window' | 'background') => void): () => void;
      publish(state: Record<string, unknown>): void;
      reportFailure?(kind: 'react-root' | 'visualizer' | 'visualizer-cleanup', mode?: string): void;
      onCommand(handler: (command: Record<string, any>) => Promise<unknown>): () => void;
    };
  }
}
type Options = {
  playbackReady: boolean;
  playSong: (song: SongResult, queue?: SongResult[], fm?: boolean, options?: any) => Promise<void>;
  addOnlineSongToQueue: (song: SongResult) => unknown;
  playSongNext: (song: SongResult) => void;
  canPlaySongNext: () => boolean;
  localSongs: LocalSong[];
  resume: () => Promise<void>;
  pause: () => void;
  next: () => void | Promise<void>;
  previous: () => void;
  shuffleQueue: () => void;
  isNowPlayingStageActive: boolean;
  audio: () => HTMLAudioElement | null;
  audioContext: () => AudioContext | null;
  seekTransition: (seconds: number) => boolean;
};
const summary = (song: SongResult) => ({
  id: getPlaybackSongKey(song), title: song.name,
  artist: song.artists?.map(artist => artist.name).join(' / ') || '',
  album: song.album?.name || '',
});

// playSong reports load failures through Folia's status store rather than rejecting.
// Confirm the requested source, not an old track that happened to remain in the player.
async function verifyRequestedPlayback(song: SongResult, play: () => Promise<void>, isCurrent: () => boolean) {
  const target = getPlaybackSongKey(song);
  const before = usePlaybackStore.getState();
  const initialId = before.currentSong ? getPlaybackSongKey(before.currentSong) : '';
  const previousMessage = useStatusMessageStore.getState().message;
  let superseded = false;
  let selectedTarget = false;
  const unsubscribe = usePlaybackStore.subscribe(state => {
    const selected = state.currentSong ? getPlaybackSongKey(state.currentSong) : '';
    if (selected === target) selectedTarget = true;
    else if (selectedTarget || selected !== initialId) superseded = true;
  });
  try {
    await play();
    if (!isCurrent() || superseded) throw new Error(i18n.t('status.playbackRequestSuperseded'));
    const state = usePlaybackStore.getState();
    const message = useStatusMessageStore.getState().message;
    const failure = message !== previousMessage && message?.type === 'error' ? message.text : null;
    const ready = state.currentSong && getPlaybackSongKey(state.currentSong) === target && state.audioSrc?.trim();
    const unchangedSource = initialId === target && state.audioSrc === before.audioSrc;
    if (!ready || (unchangedSource && failure)) {
      throw new Error(failure || i18n.t('status.playbackSourceUnconfirmed'));
    }
  } finally {
    unsubscribe();
  }
}

export function useHarbourMusicBridge(options: Options) {
  const current = useRef(options);
  current.current = options;
  useEffect(() => {
    const bridge = window.harbourFolia;
    if (!bridge) return;
    const candidates = new Map<string, SongResult>();
    const audioHealth = createAudioPlaybackHealth();
    const lyricWindow = createHarbourLyrics();
    let playbackCommandRevision = 0;
    const localSongs = () => current.current.localSongs.map(localSong => buildUnifiedLocalSong({ localSong, matchedSong: null, coverUrl: null, preferOnlineMetadata: false }));
    let active = true;
    const shuffleAvailable = () => {
      const state = usePlaybackStore.getState();
      return !state.isFmMode && !current.current.isNowPlayingStageActive && state.playQueue.length > 1;
    };
    const playbackModeAvailable = () => !usePlaybackStore.getState().isFmMode && !current.current.isNowPlayingStageActive;
    const snapshot = () => {
      const state = usePlaybackStore.getState();
      const audio = current.current.audio();
      const tracks = state.playQueue.slice(0, 200).map(summary);
      if (state.currentSong && !tracks.some(track => track.id === getPlaybackSongKey(state.currentSong!))) tracks.unshift(summary(state.currentSong));
      return {
        provider: 'folia', connected: true, loaded: !!state.currentSong,
        playbackReady: current.current.playbackReady,
        paused: state.playerState !== PlayerState.PLAYING,
        playbackStatus: state.playerState,
        volume: Math.round(useAudioSettingsStore.getState().volume * 100),
        audioQuality: useAudioSettingsStore.getState().audioQuality,
        positionMs: Math.round((audio?.currentTime || 0) * 1000),
        sampledAt: Date.now(),
        clockRunning: !!audio && !audio.paused && !audio.seeking && audio.readyState >= 3 && state.playerState === PlayerState.PLAYING,
        playbackRate: audio?.playbackRate || 1,
        lyrics: lyricWindow(state.currentSong ? getPlaybackSongKey(state.currentSong) : '', state.lyrics,
          audio?.currentTime || 0, state.lyricTimelineOffsetMs, !!state.transitionDisplay),
        durationMs: Math.round((Number.isFinite(audio?.duration) ? audio!.duration : state.duration || 0) * 1000),
        currentTrackId: state.currentSong ? getPlaybackSongKey(state.currentSong) : '', tracks,
        source: useOnlineProviderAccountStore.getState().activeProviderId,
        shuffleAvailable: shuffleAvailable(),
        playbackMode: state.isFmMode && useAudioSettingsStore.getState().loopMode === 'shuffle' ? 'off' : useAudioSettingsStore.getState().loopMode,
        playbackModeAvailable: playbackModeAvailable(),
        playNextAvailable: current.current.canPlaySongNext(),
        audioHealth: audioHealth.read(audio, current.current.audioContext()),
      };
    };
    const publish = () => { if (active) bridge.publish(snapshot()); };
    const unsubscribe = bridge.onCommand(async command => {
      const action = String(command.action || '');
      const playbackRevision = ['play', 'pause', 'resume', 'next', 'previous', 'stop'].includes(action)
        ? ++playbackCommandRevision : playbackCommandRevision;
      // Cold IPC can arrive before IndexedDB/provider restoration. Wait for that
      // one restore, never replay a command or use yesterday's transport closure.
      if (['play', 'resume', 'next', 'previous', 'enqueue', 'play_next'].includes(action)) {
        const deadline = Date.now() + 20_000;
        while (!current.current.playbackReady) {
          if (!active || playbackRevision !== playbackCommandRevision) throw new Error(i18n.t('status.playbackRequestSuperseded'));
          if (Date.now() >= deadline) throw new Error(i18n.t('status.playbackRestorePending'));
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (!active || playbackRevision !== playbackCommandRevision) throw new Error(i18n.t('status.playbackRequestSuperseded'));
      }
      const opt = current.current;
      let playbackConfirmation: 'source-loaded' | undefined;
      const resume = async () => {
        const state = usePlaybackStore.getState();
        // An empty HTMLAudioElement.play() can remain pending indefinitely.
        // Stage lyric-only playback is valid without an ordinary current song.
        if (!state.currentSong && state.activePlaybackContext !== 'stage') throw new Error('NO_ACTIVE_TRACK');
        if (!state.audioSrc?.trim() && state.activePlaybackContext !== 'stage') throw new Error(i18n.t('status.playbackSourceUnconfirmed'));
        await opt.resume();
      };
      if (action === 'status' || action === 'queue') return snapshot();
      if (action === 'search') {
        const query = String(command.query || '').trim();
        if (!query || query.length > 300) throw new Error('请输入 1–300 字的歌曲关键词');
        const provider = command.source || useOnlineProviderAccountStore.getState().activeProviderId;
        let songs: SongResult[];
        if (provider === 'local') {
          songs = localSongs().filter(song => `${song.name} ${summary(song).artist}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 20);
        } else {
          if (!['qq', 'netease', 'kugou'].includes(provider)) throw new Error('该音源请在 Folia 曲库页面浏览');
          songs = (await omni.searchProviderSongs(provider, query, { limit: 20, offset: 0 })).items;
        }
        if (!active) throw new Error('音乐模块已关闭');
        for (const song of songs) candidates.set(getPlaybackSongKey(song), song);
        while (candidates.size > 200) candidates.delete(candidates.keys().next().value!);
        return { source: provider, tracks: songs.map(summary) };
      }
      if (action === 'play' || action === 'enqueue' || action === 'play_next') {
        const id = String(command.trackId || '');
        if (!id && command.query) throw new Error('请先搜索并使用返回的曲目 ID');
        if (!id && action === 'play') await resume();
        else {
          const state = usePlaybackStore.getState();
          const queuedSong = state.playQueue.find(song => getPlaybackSongKey(song) === id);
          const song = (action === 'play_next' ? queuedSong : undefined) || candidates.get(id) || queuedSong || localSongs().find(song => getPlaybackSongKey(song) === id);
          if (!song) throw new Error('曲目 ID 不在当前搜索结果或曲库中，请重新搜索');
          if (action === 'enqueue') opt.addOnlineSongToQueue(song);
          else if (action === 'play_next') opt.playSongNext(song);
          else {
            await verifyRequestedPlayback(
              song,
              () => opt.playSong(song, state.playQueue.some(item => getPlaybackSongKey(item) === id) ? state.playQueue : [song]),
              () => active && playbackRevision === playbackCommandRevision,
            );
            // This confirms a loaded source, not audible output: autoplay may still be pending/paused.
            playbackConfirmation = 'source-loaded';
          }
        }
      } else if (action === 'pause') opt.pause();
      else if (action === 'resume') await resume();
      else if (action === 'next') await opt.next();
      else if (action === 'previous') opt.previous();
      else if (action === 'set_playback_mode') {
        if (!playbackModeAvailable()) throw new Error(i18n.t('status.shuffleUnavailable'));
        if (!['off', 'all', 'one', 'shuffle'].includes(command.playbackMode)) throw new Error('INVALID_PLAYBACK_MODE');
        useAudioSettingsStore.getState().setLoopMode(command.playbackMode as StageLoopMode);
      }
      else if (action === 'shuffle') {
        const state = usePlaybackStore.getState();
        if (state.isFmMode || opt.isNowPlayingStageActive) throw new Error(i18n.t('status.shuffleUnavailable'));
        if (state.playQueue.length < 2) throw new Error(i18n.t('status.shuffleNeedsQueue'));
        opt.shuffleQueue(); // Same queue action as Folia's panel / command palette; no new player or mode.
      }
      else if (action === 'stop') { opt.pause(); if (opt.audio()) opt.audio()!.currentTime = 0; }
      else if (action === 'set_volume') {
        if (!Number.isFinite(command.volume) || command.volume < 0 || command.volume > 100) throw new Error('音量须为 0–100');
        useAudioSettingsStore.getState().handleSetVolume(command.volume / 100);
      } else if (action === 'seek') {
        if (!Number.isFinite(command.positionMs) || command.positionMs < 0) throw new Error('进度须为非负毫秒数');
        const audio = opt.audio();
        if (!audio) throw new Error('当前无可定位音频');
        const seconds = Math.min(command.positionMs / 1000, Number.isFinite(audio.duration) ? audio.duration : command.positionMs / 1000);
        if (!opt.seekTransition(seconds)) audio.currentTime = seconds;
      } else throw new Error(`不支持的音乐操作：${action}`);
      publish();
      return { accepted: true, ...(playbackConfirmation ? { playbackConfirmation } : {}), ...snapshot() };
    });
    publish(); void bridge.ready();
    // Discrete mode changes publish immediately; playback time never enters React state.
    const unsubscribeMode = useAudioSettingsStore.subscribe((state, previous) => {
      if (state.loopMode !== previous.loopMode || state.volume !== previous.volume) publish();
    });
    // Coalesce synchronous song/lyrics store writes. Pause, seek-related line
    // changes and late-arriving lyrics should not wait for the next heartbeat.
    let scheduled = false;
    const unsubscribePlayback = usePlaybackStore.subscribe((state, previous) => {
      if (state.currentSong === previous.currentSong && state.lyrics === previous.lyrics
        && state.currentLineIndex === previous.currentLineIndex && state.playerState === previous.playerState
        && state.lyricTimelineOffsetMs === previous.lyricTimelineOffsetMs && state.transitionDisplay === previous.transitionDisplay) return;
      if (!scheduled) { scheduled = true; queueMicrotask(() => { scheduled = false; publish(); }); }
    });
    const timer = window.setInterval(publish, 1000); // transport snapshot, never React frame state
    return () => { active = false; clearInterval(timer); unsubscribe(); unsubscribeMode(); unsubscribePlayback(); audioHealth.dispose(); };
  }, []);
}
