import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalSong, SongResult, UnifiedSong } from '../../../src/types';
import type { PlaybackNavigationOptions } from '../../../src/types/appPlayback';
import { usePlaybackQueueController } from '../../../src/hooks/usePlaybackQueueController';
import { getPlaybackOrder } from '../../../src/services/playbackOrder';
import { getPlaybackSongKey, isLocalPlaybackSong } from '../../../src/utils/appPlaybackGuards';
import { setAudioSrc, setCurrentSong, setCurrentLineIndex, setDuration, setPlayerState } from '../../../src/stores/usePlaybackStore';
import { loadOnlineLyricsState } from '../../../src/utils/onlineLyricsState';

// Exercise real navigation, queue edits and delayed online loads, with no audio device or provider IO.
type HookHarness = {
    refs: Array<{ current: unknown }>;
    refIndex: number;
    effectDeps: Array<readonly unknown[] | undefined>;
    effectIndex: number;
    pendingEffects: Array<() => unknown>;
};
const fixture = vi.hoisted(() => ({
    playback: {} as any, settings: {} as any, held: null as SongResult | null,
    status: vi.fn(), loadAudio: vi.fn(), getFm: vi.fn(), prefetch: vi.fn(), refreshPrefetch: vi.fn(),
    unavailableIds: [] as Array<string | number>, unsupportedIds: [] as Array<string | number>,
    hooks: null as HookHarness | null,
}));
vi.mock('react', () => ({
    useCallback: (callback: unknown) => callback,
    useRef: (current: unknown) => {
        const hooks = fixture.hooks!;
        const index = hooks.refIndex++;
        return hooks.refs[index] ??= { current };
    },
    useState: (value: unknown) => [value, vi.fn()],
    useEffect: (effect: () => unknown, deps?: readonly unknown[]) => {
        const hooks = fixture.hooks!;
        const index = hooks.effectIndex++;
        const previous = hooks.effectDeps[index];
        if (!deps || !previous || deps.some((value, dep) => !Object.is(value, previous[dep]))) {
            hooks.pendingEffects.push(effect);
            hooks.effectDeps[index] = deps?.slice();
        }
    },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../src/hooks/useStableCallbacks', () => ({ useStableActionSurface: (value: unknown) => value }));
vi.mock('../../../src/stores/usePlaybackStore', () => ({
    usePlaybackStore: Object.assign((select: (state: any) => unknown) => select(fixture.playback), { getState: () => fixture.playback }),
    setIsFmMode: (isFmMode: boolean) => { fixture.playback.isFmMode = isFmMode; },
    setPlayQueue: vi.fn((playQueue: SongResult[]) => { fixture.playback.playQueue = playQueue; }),
    setPlayerState: vi.fn((playerState: string) => { fixture.playback.playerState = playerState; }),
    setAudioSrc: vi.fn(), setCachedCoverUrl: vi.fn(), setCurrentLineIndex: vi.fn(),
    setCurrentSong: vi.fn((song: SongResult | null | ((previous: SongResult | null) => SongResult | null)) => {
        fixture.playback.currentSong = typeof song === 'function' ? song(fixture.playback.currentSong) : song;
    }), setDuration: vi.fn(),
}));
vi.mock('../../../src/stores/useAudioSettingsStore', () => ({
    useAudioSettingsStore: Object.assign((select: (state: any) => unknown) => select(fixture.settings), { getState: () => fixture.settings }),
}));
vi.mock('../../../src/stores/useSearchNavigationStore', () => ({ useSearchNavigationStore: (select: (state: any) => unknown) => select({ searchQuery: '', searchSourceTab: 'qq' }) }));
vi.mock('../../../src/stores/useStatusMessageStore', () => ({ setStatusMessage: fixture.status }));
vi.mock('../../../src/stores/motionSignals', () => ({ currentTime: { get: () => 0, set: vi.fn() } }));
vi.mock('../../../src/stores/useAppViewStore', () => ({ setIsPanelOpen: vi.fn(), setPanelTab: vi.fn() }));
vi.mock('../../../src/stores/usePlaybackEntryViewStore', () => ({ showLatticeFmNotice: vi.fn(), usePlaybackEntryViewStore: { getState: () => ({ playbackEntryView: 'player' }) } }));
vi.mock('../../../src/services/onlinePlayback', () => ({ applyOnlineAudioSourceMetadata: (song: SongResult) => song, loadOnlineSongAudioSource: fixture.loadAudio, loadOnlineSongLyrics: vi.fn() }));
vi.mock('../../../src/services/onlineMusic/songAvailability', () => ({ getSongReplacement: vi.fn(), isSongUnavailable: (song: SongResult) => fixture.unavailableIds.includes(song.id) }));
vi.mock('../../../src/services/onlineMusic/omni', () => ({ omni: { canPlaySong: (song: SongResult) => !fixture.unsupportedIds.includes(song.id), getPersonalFm: fixture.getFm } }));
vi.mock('../../../src/services/onlineMusic/resourceCache', () => ({ getCachedSongCoverUrl: vi.fn(), hasCachedSongAudio: vi.fn() }));
vi.mock('../../../src/services/prefetchService', () => ({ getPrefetchedData: vi.fn(), invalidateAndRefetch: fixture.refreshPrefetch, prefetchNearbySongs: fixture.prefetch }));
vi.mock('../../../src/services/playbackBlobUrls', () => ({ retireBlobUrl: vi.fn() }));
vi.mock('../../../src/utils/onlineLyricsState', () => ({ loadOnlineLyricsState: vi.fn() }));
vi.mock('../../../src/utils/stagePlayerSnapshot', () => ({ buildStagePlayerSnapshot: vi.fn(), resolveStagePlayerQueueItemIndex: vi.fn() }));
vi.mock('../../../src/components/app/search/searchTrackActions', () => ({ dispatchSearchTrackAction: vi.fn() }));
vi.mock('../../../src/services/onlineMusic/songMetadata', () => ({ getProviderSongMetadata: () => ({}) }));

const localSongs: LocalSong[] = Array.from({ length: 8 }, (_, index) => ({
    id: `local-${index}`, fileName: `fixture-${index}.mp3`, filePath: `/fixtures/fixture-${index}.mp3`,
    duration: 180000, fileSize: 1000, mimeType: 'audio/mpeg', addedAt: 1,
    title: `Local ${index}`, titleOrigin: 'import',
    importedMetadata: { title: `Local ${index}`, titleSource: 'filename', artistNames: [] },
}));
const queue: UnifiedSong[] = localSongs.map(song => ({
    id: song.id, name: song.title, artists: [], album: { id: 1, name: 'Fixture' }, durationMs: song.duration,
    sourceRef: { kind: 'local', mediaId: song.id }, isLocal: true, localRef: { songId: song.id },
}));
const keys = (songs: SongResult[]) => songs.map(getPlaybackSongKey);
const onlineSong = (id: string): SongResult => ({
    id, name: `QQ ${id}`, artists: [], album: { id: 1, name: 'Fixture' }, durationMs: 180000,
    sourceRef: { kind: 'online', providerId: 'qq', mediaId: id },
});
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
};

function createController(stage = false) {
    const audio = { currentTime: 0, duration: 180, pause: vi.fn() };
    const onPlayLocalSong = vi.fn(async (song: LocalSong, _queue?: LocalSong[], _options?: PlaybackNavigationOptions) => {
        fixture.playback.currentSong = queue.find(item => item.localRef?.songId === song.id);
    });
    const endHeldTransition = vi.fn(() => { fixture.held = null; });
    const options = {
        isNowPlayingStageActive: stage, shouldNavigateToPlayerOnTrackChange: false,
        localSongs, localLibraryCatalog: {}, setLyrics: vi.fn(), setIsLyricsLoading: vi.fn(),
        navigateToPlaybackView: vi.fn(), navigateToSearch: vi.fn(), persistLastPlaybackCache: vi.fn().mockResolvedValue(undefined),
        restoreCachedThemeForSong: vi.fn(), interruptStagePlaybackForMainTransition: vi.fn(),
        onPlayLocalSong, onPlayNavidromeSong: vi.fn(), onAddLocalSongToQueue: vi.fn(), onAddNavidromeSongsToQueue: vi.fn(),
        searchDeps: { submitSearch: vi.fn(), loadMoreSearchResults: vi.fn() },
        audioRef: { current: audio }, blobUrlRef: { current: null }, shouldAutoPlayRef: { current: false },
        currentSongRef: { current: null }, mainPlaybackSnapshotRef: { current: null }, playbackAutoSkipCountRef: { current: 0 },
        pendingResumeTimeRef: { current: null }, currentOnlineAudioUrlFetchedAtRef: { current: null }, lastAudioRecoverySourceRef: { current: null },
        getDisplaySong: () => fixture.held, endHeldTransition,
    } as unknown as Parameters<typeof usePlaybackQueueController>[0];
    const hooks: HookHarness = { refs: [], refIndex: 0, effectDeps: [], effectIndex: 0, pendingEffects: [] };
    // Re-evaluate selectors with stable refs. Flush passive effects explicitly after state commits.
    return {
        render: () => {
            fixture.hooks = hooks;
            hooks.refIndex = 0;
            hooks.effectIndex = 0;
            return usePlaybackQueueController(options);
        },
        flushEffects: () => { for (const effect of hooks.pendingEffects.splice(0)) effect(); },
        onPlayLocalSong, endHeldTransition, audio, options,
    };
}

function expectLocalTarget(controller: ReturnType<typeof createController>, target: SongResult) {
    if (!isLocalPlaybackSong(target)) throw new Error('Expected a local playback fixture');
    const localId = target.localRef.songId;
    expect(controller.onPlayLocalSong).toHaveBeenLastCalledWith(
        localSongs.find(song => song.id === localId), localSongs,
        expect.objectContaining({ unifiedQueue: queue, shouldNavigateToPlayer: false }),
    );
    const canonical = controller.onPlayLocalSong.mock.calls.at(-1)?.[2]?.unifiedQueue;
    expect(canonical).toEqual(queue);
    expect(keys(canonical!)).toEqual(keys(queue));
    expect(fixture.playback.playQueue).toBe(queue);
    expect(fixture.loadAudio).not.toHaveBeenCalled();
    expect(fixture.prefetch).not.toHaveBeenCalled();
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    fixture.settings = { loopMode: 'shuffle', shuffleSeed: 451, shuffleOrderKeys: [], shuffleRevision: 0, audioQuality: 'high', queueAddBehavior: 'append' };
    fixture.settings.setLoopMode = vi.fn((mode: string) => { fixture.settings.loopMode = mode; });
    fixture.settings.setShuffleOrderKeys = vi.fn((orderKeys: string[]) => {
        fixture.settings.shuffleOrderKeys = orderKeys;
        fixture.settings.shuffleRevision++;
    });
    fixture.playback = { activePlaybackContext: 'main', currentSong: queue[0], playQueue: queue, playerState: 'PLAYING', isFmMode: false };
    fixture.unavailableIds = []; fixture.unsupportedIds = [];
    fixture.held = null;
    fixture.getFm.mockResolvedValue([]);
    fixture.refreshPrefetch.mockResolvedValue(undefined);
});

describe('management add-to-queue operation', () => {
    it.each(['append', 'next'])('keeps successive %s clicks against the live queue before rendering', behavior => {
        fixture.settings.queueAddBehavior = behavior;
        const controller = createController();
        const actions = controller.render();
        const first = onlineSong('other-playlist-1'), second = onlineSong('other-playlist-2');
        actions.addOnlineSongToQueue(first);
        actions.addOnlineSongToQueue(second);
        expect(fixture.playback.playQueue).toEqual(behavior === 'next'
            ? [queue[0], second, first, ...queue.slice(1)] : [...queue, first, second]);
    });

    it('uses the latest insertion preference and current song instead of the open list render snapshot', () => {
        const actions = createController().render();
        fixture.settings.queueAddBehavior = 'next';
        fixture.playback.currentSong = queue[3];
        const inserted = onlineSong('other-playlist');
        actions.addOnlineSongToQueue(inserted);
        expect(fixture.playback.playQueue).toEqual([...queue.slice(0, 4), inserted, ...queue.slice(4)]);
    });

    it.each(['PLAYING', 'PAUSED'])('honors next preference in repeat-one while %s without restarting the current audio', state => {
        fixture.settings.queueAddBehavior = 'next';
        fixture.settings.loopMode = 'one';
        fixture.playback.playerState = state;
        const controller = createController();
        const actions = controller.render(); controller.flushEffects();
        const inserted = onlineSong('other-playlist');
        actions.addOnlineSongToQueue(inserted);
        expect(fixture.settings.loopMode).toBe('all');
        expect(fixture.playback.playQueue).toEqual([queue[0], inserted, ...queue.slice(1)]);
        expect(fixture.playback.currentSong).toBe(queue[0]);
        expect(fixture.playback.playerState).toBe(state);
        expect(fixture.loadAudio).not.toHaveBeenCalled();
        expect(controller.audio.pause).not.toHaveBeenCalled();
        expect(fixture.status).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'status.added_to_next_play_repeat' }));
    });

    it('keeps append preference and repeat-one unchanged for an ordinary queue append', () => {
        fixture.settings.loopMode = 'one';
        const inserted = onlineSong('other-playlist');
        createController().render().addOnlineSongToQueue(inserted);
        expect(fixture.settings.loopMode).toBe('one');
        expect(fixture.playback.playQueue).toEqual([...queue, inserted]);
        expect(fixture.status).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'status.added_to_play_queue' }));
    });

    it.each(['off', 'all', 'shuffle'] as const)('refreshes the committed %s next candidate, including on resume', mode => {
        fixture.settings.queueAddBehavior = 'next';
        fixture.settings.loopMode = mode;
        fixture.playback.playerState = 'PAUSED';
        const controller = createController();
        const actions = controller.render(); controller.flushEffects();
        const inserted = onlineSong('other-playlist');
        actions.addOnlineSongToQueue(inserted);
        controller.render(); controller.flushEffects();
        expect(fixture.refreshPrefetch).not.toHaveBeenCalled();
        fixture.playback.playerState = 'PLAYING';
        controller.render(); controller.flushEffects();
        expect(fixture.refreshPrefetch).toHaveBeenCalledExactlyOnceWith(queue[0], fixture.playback.playQueue, 'high', undefined);
        const order = getPlaybackOrder(fixture.playback.playQueue, mode);
        expect(order[order.findIndex(song => getPlaybackSongKey(song) === getPlaybackSongKey(queue[0])) + 1]).toBe(inserted);
        controller.render(); controller.flushEffects();
        expect(fixture.refreshPrefetch).toHaveBeenCalledOnce();
    });

    it('inserts a batch next without losing provider identity or the current queue anchor', () => {
        fixture.settings.queueAddBehavior = 'next';
        fixture.playback.playQueue = queue.slice(1);
        const qq = onlineSong('123');
        const netease = { ...qq, sourceRef: { kind: 'online', providerId: 'netease', mediaId: '123' } } as SongResult;
        createController().render().addOnlineSongsToQueue([qq, netease, qq]);
        expect(fixture.playback.playQueue).toEqual([queue[0], qq, netease, ...queue.slice(1)]);
        const order = getPlaybackOrder(fixture.playback.playQueue, 'shuffle');
        const anchor = order.findIndex(song => getPlaybackSongKey(song) === getPlaybackSongKey(queue[0]));
        expect(order.slice(anchor, anchor + 3)).toEqual([queue[0], qq, netease]);
    });

    it('moves an already adjacent canonical song next in shuffle and confirms the ordering change', () => {
        fixture.settings.queueAddBehavior = 'next';
        fixture.settings.shuffleOrderKeys = keys([queue[0], queue[4], queue[3], queue[1], ...queue.slice(5), queue[2]]);
        createController().render().addOnlineSongToQueue(queue[1]);
        expect(fixture.playback.playQueue).toEqual(queue);
        expect(getPlaybackOrder(queue, 'shuffle')[1]).toBe(queue[1]);
        expect(fixture.status).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'status.added_to_next_play' }));
    });

    it('does not change repeat mode or prefetch for empty, current-song and unavailable requests', () => {
        fixture.settings.queueAddBehavior = 'next';
        fixture.settings.loopMode = 'one';
        const unavailable = onlineSong('blocked');
        fixture.unavailableIds = [unavailable.id];
        const actions = createController().render();
        actions.addOnlineSongsToQueue([]);
        actions.addOnlineSongToQueue(queue[0]);
        actions.addOnlineSongsToQueue([unavailable]);
        expect(fixture.settings.setLoopMode).not.toHaveBeenCalled();
        expect(fixture.refreshPrefetch).not.toHaveBeenCalled();
        expect(fixture.status).not.toHaveBeenCalled();
    });

    it('updates only the saved main queue if Stage takes ownership before a list action arrives', () => {
        fixture.settings.queueAddBehavior = 'next';
        fixture.settings.loopMode = 'one';
        const controller = createController();
        const actions = controller.render();
        controller.options.mainPlaybackSnapshotRef.current = {
            currentSong: queue[0], playQueue: queue, isFmMode: false, playerState: 'PAUSED',
            lyrics: null, cachedCoverUrl: null, audioSrc: null, currentTime: 0, duration: 180, currentLineIndex: -1,
        } as NonNullable<typeof controller.options.mainPlaybackSnapshotRef.current>;
        fixture.playback.activePlaybackContext = 'stage';
        fixture.playback.currentSong = onlineSong('stage');
        fixture.playback.playQueue = [fixture.playback.currentSong];
        const stageQueue = fixture.playback.playQueue;
        const inserted = onlineSong('other-playlist');
        actions.addOnlineSongToQueue(inserted);
        expect(controller.options.mainPlaybackSnapshotRef.current.playQueue).toEqual([queue[0], inserted, ...queue.slice(1)]);
        expect(fixture.playback.playQueue).toBe(stageQueue);
        expect(fixture.settings.loopMode).toBe('one');
        expect(fixture.refreshPrefetch).not.toHaveBeenCalled();
    });
});

describe('explicit play-next queue operation', () => {
    it.each(['off', 'shuffle', 'one'])('plays a cross-playlist insertion on an immediate %s next event before React renders', async mode => {
        fixture.settings.loopMode = mode;
        fixture.loadAudio.mockResolvedValue({ kind: 'unavailable', reason: 'network' });
        const target = onlineSong('other-playlist');
        const controller = createController();
        const actions = controller.render();
        actions.playSongNext(target);
        await actions.handleNextTrack({ allowStopOnMissing: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.loadAudio).toHaveBeenCalledExactlyOnceWith(target, 'high', undefined);
        expect(controller.onPlayLocalSong).not.toHaveBeenCalled();
        expect(fixture.playback.playQueue).toEqual([queue[0], target, ...queue.slice(1)]);
    });

    it('keeps a cross-playlist insertion when an already pending audio load commits', async () => {
        const originalQueue = [onlineSong('current'), onlineSong('old-next')];
        fixture.playback.currentSong = originalQueue[0];
        fixture.playback.playQueue = originalQueue;
        const audio = deferred<{ kind: 'ok'; audioSrc: string }>();
        fixture.loadAudio.mockReturnValueOnce(audio.promise);
        const controller = createController();
        const actions = controller.render();
        const loading = actions.playSong(originalQueue[0], originalQueue);
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.loadAudio).toHaveBeenCalledOnce();
        const target = onlineSong('other-playlist');
        actions.playSongNext(target);
        const committed = fixture.playback.playQueue;
        audio.resolve({ kind: 'ok', audioSrc: 'https://fixture.invalid/current.mp3' });
        await loading;
        expect(fixture.playback.playQueue).toEqual(committed);
        expect(getPlaybackOrder(fixture.playback.playQueue, 'shuffle').slice(0, 2)).toEqual([originalQueue[0], target]);
        expect(controller.options.persistLastPlaybackCache).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'current' }), committed);
        expect(fixture.prefetch).toHaveBeenLastCalledWith(originalQueue[0], committed, 'high', undefined);
    });

    it('prefetches the edited queue after slow theme loading instead of restoring the old next candidate', async () => {
        const originalQueue = [onlineSong('current'), onlineSong('old-next')];
        fixture.playback.currentSong = originalQueue[0];
        fixture.playback.playQueue = originalQueue;
        fixture.loadAudio.mockResolvedValueOnce({ kind: 'ok', audioSrc: 'https://fixture.invalid/current.mp3' });
        const theme = deferred<undefined>();
        const controller = createController();
        vi.mocked(controller.options.restoreCachedThemeForSong).mockReturnValueOnce(theme.promise);
        const actions = controller.render();
        const loading = actions.playSong(originalQueue[0], originalQueue);
        await vi.advanceTimersByTimeAsync(0);
        expect(controller.options.restoreCachedThemeForSong).toHaveBeenCalledOnce();
        actions.playSongNext(onlineSong('other-playlist'));
        const committed = fixture.playback.playQueue;
        theme.resolve(undefined);
        await loading;
        expect(fixture.prefetch).toHaveBeenLastCalledWith(originalQueue[0], committed, 'high', undefined);
    });

    it.each([false, true])('does not resurrect removed songs during an audio load (clear queue: %s)', async clear => {
        const originalQueue = [onlineSong('current'), onlineSong('removed')];
        fixture.playback.currentSong = originalQueue[0];
        fixture.playback.playQueue = originalQueue;
        const audio = deferred<{ kind: 'ok'; audioSrc: string }>();
        fixture.loadAudio.mockReturnValueOnce(audio.promise);
        const controller = createController();
        const loading = controller.render().playSong(originalQueue[0], originalQueue);
        await vi.advanceTimersByTimeAsync(0);
        const editedQueue = clear ? [] : [originalQueue[0]];
        fixture.playback.playQueue = editedQueue;
        audio.resolve({ kind: 'ok', audioSrc: 'https://fixture.invalid/current.mp3' });
        await loading;
        expect(fixture.playback.playQueue).toEqual(editedQueue);
        expect(controller.options.persistLastPlaybackCache).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'current' }), editedQueue);
        expect(fixture.prefetch).not.toHaveBeenCalled();
    });

    it('still replaces the queue when the user explicitly starts a different playlist', async () => {
        const replacementQueue = [onlineSong('other-current'), onlineSong('other-next')];
        fixture.loadAudio.mockResolvedValueOnce({ kind: 'ok', audioSrc: 'https://fixture.invalid/current.mp3' });
        await createController().render().playSong(replacementQueue[0], replacementQueue);
        expect(fixture.playback.playQueue).toEqual(replacementQueue);
        expect(fixture.playback.currentSong).toMatchObject({ id: 'other-current' });
    });

    it('does not let an obsolete lyrics-state read overwrite a newer playback selection', async () => {
        const first = onlineSong('first');
        const second = onlineSong('second');
        const lyricsState = deferred<null>();
        vi.mocked(loadOnlineLyricsState).mockReturnValueOnce(lyricsState.promise);
        fixture.loadAudio.mockResolvedValue({ kind: 'ok', audioSrc: 'https://fixture.invalid/current.mp3' });
        const controller = createController();
        const actions = controller.render();
        const obsolete = actions.playSong(first, [first, ...queue]);
        await vi.advanceTimersByTimeAsync(0);
        expect(loadOnlineLyricsState).toHaveBeenCalledWith(first);
        await actions.playSong(second, [second, ...queue]);
        lyricsState.resolve(null);
        await obsolete;
        expect(fixture.playback.currentSong).toMatchObject({ id: 'second' });
        expect(fixture.playback.playQueue).toEqual([second, ...queue]);
        expect(controller.options.persistLastPlaybackCache).toHaveBeenCalledOnce();
    });

    it.each(['PLAYING', 'PAUSED'])('moves an existing song next without touching the %s current deck or queue preference', state => {
        fixture.settings.loopMode = 'off';
        fixture.playback.playerState = state;
        fixture.playback.audioSrc = 'blob:current-fixture';
        fixture.playback.duration = 180;
        fixture.playback.currentLineIndex = 7;
        const before = { ...fixture.playback };
        const controller = createController();
        controller.audio.currentTime = 47;
        const actions = controller.render(); controller.flushEffects();
        expect(actions.canPlaySongNext()).toBe(true);
        expect(actions.playSongNext(queue[5])).toBeUndefined();
        const expected = [queue[0], queue[5], ...queue.slice(1, 5), ...queue.slice(6)];
        expect(fixture.playback).toEqual({ ...before, playQueue: expected });
        expect(fixture.settings.queueAddBehavior).toBe('append');
        expect(fixture.settings.loopMode).toBe('off');
        expect(controller.audio.currentTime).toBe(47);
        expect(controller.audio.pause).not.toHaveBeenCalled();
        expect(controller.onPlayLocalSong).not.toHaveBeenCalled();
        expect(fixture.loadAudio).not.toHaveBeenCalled();
        for (const setter of [setAudioSrc, setCurrentSong, setCurrentLineIndex, setDuration, setPlayerState]) {
            expect(setter).not.toHaveBeenCalled();
        }
        expect(controller.options.interruptStagePlaybackForMainTransition).not.toHaveBeenCalled();
        expect(controller.options.persistLastPlaybackCache).toHaveBeenCalledExactlyOnceWith(queue[0], expected);
        if (state === 'PLAYING') expect(fixture.refreshPrefetch).toHaveBeenCalledExactlyOnceWith(queue[0], expected, 'high', undefined);
        else expect(fixture.refreshPrefetch).not.toHaveBeenCalled();
        expect(fixture.status).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'status.added_to_next_play' }));
    });

    it('inserts two newly browsed songs against the live queue without replacing that queue between renders', () => {
        fixture.settings.loopMode = 'all';
        const controller = createController();
        const actions = controller.render();
        const first = { ...queue[1], id: 'first', sourceRef: { kind: 'online', providerId: 'qq', mediaId: 'first' }, isLocal: false, localRef: undefined } as SongResult;
        const second = { ...first, id: 'second', sourceRef: { kind: 'online', providerId: 'qq', mediaId: 'second' } } as SongResult;
        actions.playSongNext(first);
        actions.playSongNext(second);
        expect(fixture.playback.playQueue).toEqual([queue[0], second, first, ...queue.slice(1)]);
        expect(fixture.settings.loopMode).toBe('all');
        expect(controller.onPlayLocalSong).not.toHaveBeenCalled();
    });

    it.each(['off', 'all', 'one', 'shuffle'])('defers paused %s insertions until resume and refreshes the final committed queue only once', mode => {
        fixture.settings.loopMode = mode;
        fixture.playback.playerState = 'PAUSED';
        const controller = createController();
        const actions = controller.render(); controller.flushEffects();
        actions.playSongNext(queue[3]);
        actions.playSongNext(queue[5]);
        const committed = fixture.playback.playQueue;
        expect(committed.slice(0, 3)).toEqual([queue[0], queue[5], queue[3]]);
        controller.render(); controller.flushEffects();
        expect(fixture.refreshPrefetch).not.toHaveBeenCalled();
        expect(fixture.playback.playerState).toBe('PAUSED');
        fixture.playback.playerState = 'PLAYING';
        controller.render(); controller.flushEffects();
        expect(fixture.refreshPrefetch).toHaveBeenCalledExactlyOnceWith(queue[0], committed, 'high', undefined);
        controller.render(); controller.flushEffects();
        fixture.playback.playerState = 'PAUSED';
        controller.render(); controller.flushEffects();
        fixture.playback.playerState = 'PLAYING';
        controller.render(); controller.flushEffects();
        expect(fixture.refreshPrefetch).toHaveBeenCalledOnce();
        expect(controller.onPlayLocalSong).not.toHaveBeenCalled();
        expect(fixture.loadAudio).not.toHaveBeenCalled();
    });

    it('places an existing canonical neighbor next in the separate shuffle order too', () => {
        const current = queue[0], target = queue[1];
        fixture.settings.shuffleOrderKeys = keys([current, queue[4], queue[3], target, ...queue.slice(5), queue[2]]);
        const controller = createController();
        const actions = controller.render(); controller.flushEffects();
        expect(getPlaybackOrder(queue, 'shuffle')[1]).not.toBe(target);
        actions.playSongNext(target);
        expect(fixture.playback.playQueue).toEqual(queue);
        expect(getPlaybackOrder(fixture.playback.playQueue, 'shuffle').slice(0, 2)).toEqual([current, target]);
        controller.render(); controller.flushEffects();
        expect(fixture.refreshPrefetch).toHaveBeenCalledOnce();
        expect(fixture.settings.loopMode).toBe('shuffle');
    });

    it('switches repeat-one to all so an explicit next request is audible, then prefetches the committed queue', () => {
        fixture.settings.loopMode = 'one';
        const controller = createController();
        const actions = controller.render(); controller.flushEffects();
        fixture.refreshPrefetch.mockImplementationOnce(async (_current, nextQueue) => {
            expect(fixture.settings.loopMode).toBe('all');
            expect(fixture.playback.playQueue).toBe(nextQueue);
        });
        actions.playSongNext(queue[4]);
        expect(fixture.settings.setLoopMode).toHaveBeenCalledExactlyOnceWith('all');
        expect(fixture.settings.queueAddBehavior).toBe('append');
        expect(fixture.status).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'status.added_to_next_play_repeat' }));
        controller.render(); controller.flushEffects();
        expect(fixture.refreshPrefetch).toHaveBeenCalledOnce();
    });

    it('rejects a missing current song and the current song itself without mutations', () => {
        const controller = createController();
        const actions = controller.render();
        expect(() => actions.playSongNext(queue[0])).toThrow('status.playNextCurrent');
        fixture.playback.currentSong = null;
        expect(actions.canPlaySongNext()).toBe(false);
        expect(() => actions.playSongNext(queue[1])).toThrow('status.playNextNeedsSong');
        expect(fixture.playback.playQueue).toBe(queue);
        expect(fixture.refreshPrefetch).not.toHaveBeenCalled();
        expect(controller.options.persistLastPlaybackCache).not.toHaveBeenCalled();
    });

    it.each(['fm', 'stage', 'external-stage', 'held-ref', 'held-store'])('rejects live %s ownership without ending a transition', mode => {
        const controller = createController(mode === 'external-stage');
        const actions = controller.render();
        if (mode === 'fm') fixture.playback.isFmMode = true;
        if (mode === 'stage') fixture.playback.activePlaybackContext = 'stage';
        if (mode === 'held-ref') fixture.held = queue[4];
        if (mode === 'held-store') fixture.playback.transitionDisplay = { song: queue[4] };
        expect(actions.canPlaySongNext()).toBe(false);
        expect(() => actions.playSongNext(queue[1])).toThrow('status.playNextUnavailable');
        expect(fixture.playback.playQueue).toBe(queue);
        expect(controller.endHeldTransition).not.toHaveBeenCalled();
        expect(controller.options.persistLastPlaybackCache).not.toHaveBeenCalled();
        expect(fixture.refreshPrefetch).not.toHaveBeenCalled();
    });

    it.each(['unavailable', 'unsupported'])('rejects a %s candidate without reloading audio', kind => {
        const controller = createController();
        const target = { ...queue[1], id: 'rejected', sourceRef: { kind: 'online', providerId: 'qq', mediaId: 'rejected' }, isLocal: false, localRef: undefined } as SongResult;
        if (kind === 'unavailable') fixture.unavailableIds.push(target.id);
        else fixture.unsupportedIds.push(target.id);
        expect(() => controller.render().playSongNext(target)).toThrow('status.songUnavailable');
        expect(fixture.playback.playQueue).toBe(queue);
        expect(fixture.loadAudio).not.toHaveBeenCalled();
    });

    it('retains the current anchor when its canonical queue was cleared', () => {
        fixture.playback.playQueue = [];
        fixture.settings.loopMode = 'off';
        const controller = createController();
        controller.render().playSongNext(queue[1]);
        expect(fixture.playback.playQueue).toEqual([queue[0], queue[1]]);
    });

    it('removes duplicate target entries and uses the latest current anchor before a rerender', () => {
        fixture.settings.loopMode = 'off';
        const controller = createController();
        const actions = controller.render();
        fixture.playback.playQueue = [queue[0], queue[2], queue[1], queue[1], queue[3]];
        fixture.playback.currentSong = queue[2];
        actions.playSongNext(queue[1]);
        expect(fixture.playback.playQueue).toEqual([queue[0], queue[2], queue[1], queue[3]]);
        expect(fixture.playback.currentSong).toBe(queue[2]);
        expect(controller.options.persistLastPlaybackCache).toHaveBeenLastCalledWith(queue[2], fixture.playback.playQueue);
    });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('temporary online source failures', () => {
    const target: SongResult = {
        id: 'qq-requested', name: 'Requested QQ song', artists: [], album: { id: 1, name: 'Fixture' }, durationMs: 180000,
        sourceRef: { kind: 'online', providerId: 'qq', mediaId: 'qq-requested' },
    };

    it.each([
        ['auth-required', 'status.playbackAuthRequired'],
        ['network', 'status.playbackNetworkError'],
        ['no-source', 'status.playbackNoSource'],
        ['provider-unavailable', 'status.playbackProviderUnavailable'],
        ['invalid-response', 'status.playbackInvalidResponse'],
        ['unknown', 'status.playbackRequestFailed'],
    ])('preserves the playing deck and queue on %s; no timed auto-skip', async (reason, messageKey) => {
        fixture.loadAudio.mockResolvedValue({ kind: 'unavailable', reason });
        const current = fixture.playback.currentSong;
        const beforeTarget = structuredClone(target);
        const controller = createController();
        const actions = controller.render();
        await actions.playSong(target, [target, ...queue]);
        const prompt = fixture.status.mock.calls.at(-1)?.[0];
        expect(prompt).toMatchObject({ type: 'error', text: messageKey, actionLabel: 'status.retryPlaybackAction' });
        await vi.advanceTimersByTimeAsync(10000);
        expect(fixture.loadAudio).toHaveBeenCalledTimes(1);
        expect(fixture.playback.currentSong).toBe(current);
        expect(fixture.playback.playQueue).toBe(queue);
        expect(fixture.playback.playerState).toBe('PLAYING');
        expect(target).toEqual(beforeTarget);
        expect(controller.audio.pause).not.toHaveBeenCalled();
        expect(controller.onPlayLocalSong).not.toHaveBeenCalled();
        expect(controller.options.persistLastPlaybackCache).not.toHaveBeenCalled();
        for (const setter of [setAudioSrc, setCurrentSong, setCurrentLineIndex, setDuration, setPlayerState]) {
            expect(setter).not.toHaveBeenCalled();
        }
        prompt.onAction();
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.loadAudio).toHaveBeenCalledTimes(2);
        expect(fixture.loadAudio).toHaveBeenLastCalledWith(target, 'high', undefined);
    });

    it('rejects stale retry and dismiss actions once another selection has been made', async () => {
        fixture.loadAudio.mockResolvedValue({ kind: 'unavailable', reason: 'network' });
        const actions = createController().render();
        await actions.playSong(target);
        const stalePrompt = fixture.status.mock.calls.at(-1)?.[0];
        await actions.playSong({ ...target, id: 'second', sourceRef: { kind: 'online', providerId: 'qq', mediaId: 'second' } });
        const callCount = fixture.status.mock.calls.length;
        stalePrompt.onAction();
        stalePrompt.onCancel();
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.loadAudio).toHaveBeenCalledTimes(2);
        expect(fixture.status).toHaveBeenCalledTimes(callCount);
    });

    it('keeps provider-declared unavailable handling separate from audio request failures', async () => {
        fixture.unavailableIds.push(target.id);
        await createController().render().playSong(target);
        expect(fixture.loadAudio).not.toHaveBeenCalled();
        expect(fixture.status).toHaveBeenLastCalledWith({ type: 'error', text: 'status.songUnavailable' });
    });
});

describe('real queue-controller playback mode delegation', () => {
    it('navigates next/previous along one stable shuffle order while delegating the canonical queue', async () => {
        const ordered = getPlaybackOrder(queue, 'shuffle');
        expect(keys(ordered)).not.toEqual(keys(queue));
        fixture.playback.currentSong = ordered[0];
        const controller = createController();
        for (let index = 1; index < ordered.length; index++) {
            await controller.render().handleNextTrack();
            expectLocalTarget(controller, ordered[index]);
        }
        await controller.render().handleNextTrack();
        expectLocalTarget(controller, ordered[0]);
        controller.render().handlePrevTrack();
        expectLocalTarget(controller, ordered.at(-1)!);
        controller.render().handlePrevTrack();
        expectLocalTarget(controller, ordered.at(-2)!);
        expect(fixture.getFm).not.toHaveBeenCalled();
    });

    it('manual skips follow the held blend picture but failure recovery follows the actual failed deck', async () => {
        const ordered = getPlaybackOrder(queue, 'shuffle');
        fixture.playback.currentSong = ordered[3];
        fixture.held = ordered[2];
        const controller = createController();
        await controller.render().handleNextTrack();
        expectLocalTarget(controller, ordered[3]);
        expect(controller.endHeldTransition).toHaveBeenCalledOnce();
        fixture.playback.currentSong = ordered[3]; fixture.held = ordered[2];
        controller.render().handlePrevTrack();
        expectLocalTarget(controller, ordered[1]);
        fixture.playback.currentSong = ordered[3]; fixture.held = ordered[2];
        controller.endHeldTransition.mockClear();
        await controller.render().handleNextTrack({ fromSong: ordered[3] });
        expectLocalTarget(controller, ordered[4]);
        expect(controller.endHeldTransition).not.toHaveBeenCalled();
    });

    it('the real failure-skip callback passes its failed song instead of the held picture', async () => {
        const ordered = getPlaybackOrder(queue, 'shuffle');
        fixture.playback.currentSong = ordered[3]; fixture.held = ordered[2];
        const controller = createController();
        controller.render().skipAfterPlaybackFailure();
        const prompt = fixture.status.mock.calls.map(([value]) => value).find(value => value?.onAction);
        expect(prompt).toBeDefined();
        prompt.onAction();
        await Promise.resolve();
        expectLocalTarget(controller, ordered[4]);
        expect(controller.endHeldTransition).not.toHaveBeenCalled();
    });

    it('turning shuffle off resumes canonical order without changing the queue', async () => {
        getPlaybackOrder(queue, 'shuffle');
        fixture.playback.currentSong = queue[3];
        fixture.settings.loopMode = 'off';
        const controller = createController();
        await controller.render().handleNextTrack(); expectLocalTarget(controller, queue[4]);
        controller.render().handlePrevTrack(); expectLocalTarget(controller, queue[3]);
        fixture.playback.currentSong = queue.at(-1);
        controller.onPlayLocalSong.mockClear();
        await controller.render().handleNextTrack({ allowStopOnMissing: true });
        expect(controller.onPlayLocalSong).not.toHaveBeenCalled();
        expect(controller.audio.pause).toHaveBeenCalledOnce();
        expect(fixture.playback.playerState).toBe('IDLE');
    });

    it('FM navigation ignores shuffle and preserves its sequential provider queue', async () => {
        fixture.playback.isFmMode = true; fixture.playback.currentSong = queue[2];
        const controller = createController();
        await controller.render().handleNextTrack(); expectLocalTarget(controller, queue[3]);
        controller.render().handlePrevTrack(); expectLocalTarget(controller, queue[2]);
        expect(fixture.playback.isFmMode).toBe(true);
        expect(fixture.getFm).not.toHaveBeenCalled();
        fixture.playback.currentSong = queue.at(-1);
        controller.onPlayLocalSong.mockClear();
        await controller.render().handleNextTrack({ allowStopOnMissing: true });
        expect(fixture.getFm).toHaveBeenCalledOnce();
        expect(controller.onPlayLocalSong).not.toHaveBeenCalled();
        expect(controller.audio.pause).toHaveBeenCalledOnce();
    });

    it('external Stage ownership does not change tracks or queue', async () => {
        const controller = createController(true);
        await controller.render().handleNextTrack();
        controller.render().handlePrevTrack();
        expect(controller.onPlayLocalSong).not.toHaveBeenCalled();
        expect(controller.audio.pause).not.toHaveBeenCalled();
        expect(fixture.playback.currentSong).toBe(queue[0]);
        expect(fixture.playback.playQueue).toBe(queue);
        expect(fixture.loadAudio).not.toHaveBeenCalled();
    });

    it('defers mode-change prefetch while paused, then refreshes exactly once on resume', () => {
        fixture.playback.playerState = 'PAUSED';
        fixture.settings.loopMode = 'off';
        const controller = createController();
        controller.render(); controller.flushEffects();
        fixture.settings.loopMode = 'shuffle';
        controller.render(); controller.flushEffects();
        expect(fixture.refreshPrefetch).not.toHaveBeenCalled();
        fixture.playback.playerState = 'PLAYING';
        controller.render(); controller.flushEffects();
        expect(fixture.refreshPrefetch).toHaveBeenCalledExactlyOnceWith(queue[0], queue, 'high', undefined);
        controller.render(); controller.flushEffects();
        fixture.playback.playerState = 'PAUSED';
        controller.render(); controller.flushEffects();
        fixture.playback.playerState = 'PLAYING';
        controller.render(); controller.flushEffects();
        expect(fixture.refreshPrefetch).toHaveBeenCalledOnce();
        expect(controller.onPlayLocalSong).not.toHaveBeenCalled();
        expect(fixture.loadAudio).not.toHaveBeenCalled();
    });

    it('prefetches the committed insertion queue even when order revision renders before queue commit', () => {
        const inserted: SongResult = {
            id: 'inserted', name: 'Inserted next', artists: [], album: { id: 1, name: 'Fixture' }, durationMs: 180000,
            sourceRef: { kind: 'online', providerId: 'qq', mediaId: 'inserted' },
        };
        fixture.settings.queueAddBehavior = 'next';
        const controller = createController();
        const actions = controller.render(); controller.flushEffects();
        fixture.settings.setShuffleOrderKeys = vi.fn((orderKeys: string[]) => {
            expect(fixture.playback.playQueue).toBe(queue);
            fixture.settings.shuffleOrderKeys = orderKeys;
            fixture.settings.shuffleRevision++;
            // An external-store update can render before appendOnlineSongsToMainQueue sets its queue.
            controller.render();
        });
        actions.addOnlineSongsToQueue([inserted]);
        const committedQueue = fixture.playback.playQueue as SongResult[];
        expect(fixture.settings.setShuffleOrderKeys).toHaveBeenCalledOnce();
        expect(committedQueue).toEqual([queue[0], inserted, ...queue.slice(1)]);
        // The operation now refreshes after committing, without waiting for a passive effect.
        expect(fixture.refreshPrefetch).toHaveBeenCalledExactlyOnceWith(queue[0], committedQueue, 'high', undefined);
        controller.flushEffects();
        expect(fixture.refreshPrefetch).toHaveBeenCalledExactlyOnceWith(queue[0], committedQueue, 'high', undefined);
        const order = getPlaybackOrder(committedQueue, 'shuffle');
        expect(order[order.findIndex(song => getPlaybackSongKey(song) === getPlaybackSongKey(queue[0])) + 1]).toBe(inserted);
        controller.render(); controller.flushEffects();
        expect(fixture.refreshPrefetch).toHaveBeenCalledOnce();
        expect(controller.onPlayLocalSong).not.toHaveBeenCalled();
        expect(fixture.loadAudio).not.toHaveBeenCalled();
    });
});
