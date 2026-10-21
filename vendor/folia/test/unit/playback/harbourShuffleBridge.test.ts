import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHarbourMusicBridge } from '../../../src/hooks/useHarbourMusicBridge';

// Transport regression only; real queue permutation and audio are covered by Electron smoke.
const fixture = vi.hoisted(() => ({
    state: {} as any, audioState: {} as any, cleanups: [] as Array<() => void>,
    modeListeners: new Set<(state: any, previous: any) => void>(), unsubscribeMode: vi.fn(),
    playbackListeners: new Set<(state: any, previous: any) => void>(), status: null as any,
    search: vi.fn(),
}));
vi.mock('react', () => ({
    useRef: (current: unknown) => ({ current }),
    useEffect: (effect: () => (() => void) | void) => { const cleanup = effect(); if (cleanup) fixture.cleanups.push(cleanup); },
}));
vi.mock('../../../src/stores/usePlaybackStore', () => ({ usePlaybackStore: {
    getState: () => fixture.state,
    subscribe: (listener: (state: any, previous: any) => void) => {
        fixture.playbackListeners.add(listener);
        return () => fixture.playbackListeners.delete(listener);
    },
} }));
vi.mock('../../../src/stores/useStatusMessageStore', () => ({ useStatusMessageStore: { getState: () => ({ message: fixture.status }) } }));
vi.mock('../../../src/stores/useAudioSettingsStore', () => ({ useAudioSettingsStore: {
    getState: () => fixture.audioState,
    subscribe: (listener: (state: any, previous: any) => void) => {
        fixture.modeListeners.add(listener);
        return () => { fixture.modeListeners.delete(listener); fixture.unsubscribeMode(); };
    },
} }));
vi.mock('../../../src/stores/useOnlineProviderAccountStore', () => ({ useOnlineProviderAccountStore: { getState: () => ({ activeProviderId: 'qq' }) } }));
vi.mock('../../../src/services/playbackAdapters', () => ({ buildUnifiedLocalSong: ({ localSong }: any) => ({ id: localSong.id, name: localSong.title }) }));
vi.mock('../../../src/services/onlineMusic/omni', () => ({ omni: { searchProviderSongs: fixture.search } }));
vi.mock('../../../src/services/audioPlaybackHealth', () => ({ createAudioPlaybackHealth: () => ({ read: () => ({}), dispose: vi.fn() }) }));
vi.mock('../../../src/utils/appPlaybackGuards', () => ({ getPlaybackSongKey: (song: any) => String(song.id) }));
vi.mock('../../../src/i18n/config', () => ({ default: { t: (key: string) => key } }));

beforeEach(() => {
    fixture.unsubscribeMode.mockClear();
    fixture.search.mockReset();
    fixture.modeListeners.clear();
    fixture.playbackListeners.clear(); fixture.status = null;
    fixture.state = { playQueue: [1, 2, 3].map(id => ({ id, name: `song ${id}` })), isFmMode: false, playerState: 'PAUSED', audioSrc: 'https://audio.test/ready.mp3' };
    fixture.state.currentSong = fixture.state.playQueue[0];
    fixture.audioState = { volume: 0.7, audioQuality: '320', loopMode: 'off',
        setLoopMode: vi.fn((loopMode: string) => updateAudioSettings({ loopMode })),
    };
});
afterEach(() => {
    fixture.cleanups.splice(0).forEach(cleanup => cleanup());
    expect(fixture.playbackListeners.size).toBe(0);
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function mount(stage = false) {
    let handler!: (command: any) => Promise<any>;
    const publish = vi.fn(), unsubscribeCommand = vi.fn();
    vi.stubGlobal('window', {
        harbourFolia: { ready: vi.fn().mockResolvedValue(true), publish,
            onCommand: (next: typeof handler) => { handler = next; return unsubscribeCommand; } },
        setInterval: () => 0,
    });
    const shuffleQueue = vi.fn(() => { fixture.state.playQueue = [fixture.state.playQueue[0], ...fixture.state.playQueue.slice(1).reverse()]; });
    const options = { playbackReady: true, playSong: vi.fn(), addOnlineSongToQueue: vi.fn(), localSongs: [] as any[],
        playSongNext: vi.fn(), canPlaySongNext: vi.fn(() => !!fixture.state.currentSong && !fixture.state.isFmMode && !stage && !fixture.state.transitionDisplay),
        resume: vi.fn(), pause: vi.fn(), next: vi.fn(), previous: vi.fn(), shuffleQueue,
        isNowPlayingStageActive: stage, audio: () => null, audioContext: () => null, seekTransition: vi.fn(() => false) };
    useHarbourMusicBridge(options);
    return { handler, publish, options, unsubscribeCommand };
}

function updateAudioSettings(patch: Record<string, unknown>) {
    const previous = fixture.audioState;
    fixture.audioState = { ...previous, ...patch };
    fixture.modeListeners.forEach(listener => listener(fixture.audioState, previous));
}

function updatePlayback(patch: Record<string, unknown>) {
    const previous = fixture.state;
    fixture.state = { ...fixture.state, ...patch };
    fixture.playbackListeners.forEach(listener => listener(fixture.state, previous));
}

function expectNoTransport(options: ReturnType<typeof mount>['options']) {
    for (const method of ['playSong', 'playSongNext', 'addOnlineSongToQueue', 'resume', 'pause', 'next', 'previous', 'shuffleQueue', 'seekTransition'] as const) {
        expect(options[method]).not.toHaveBeenCalled();
    }
}

describe('Harbour cold resume', () => {
    it.each(['resume', 'play'])('waits for restoration before the first %s, then invokes the latest transport exactly once', async action => {
        vi.useFakeTimers();
        const { handler, options } = mount();
        options.playbackReady = false;
        fixture.state.currentSong = null;
        fixture.state.audioSrc = null;
        const oldResume = options.resume;
        const pending = handler({ action });
        await vi.advanceTimersByTimeAsync(500);
        expect(oldResume).not.toHaveBeenCalled();
        expect((await handler({ action: 'status' })).playbackReady).toBe(false);
        fixture.state.currentSong = fixture.state.playQueue[0];
        fixture.state.audioSrc = 'https://audio.test/restored.mp3';
        options.resume = vi.fn(async () => { fixture.state.playerState = 'PLAYING'; });
        options.playbackReady = true;
        await vi.advanceTimersByTimeAsync(50);
        expect(await pending).toMatchObject({ accepted: true, paused: false, currentTrackId: '1' });
        expect(oldResume).not.toHaveBeenCalled();
        expect(options.resume).toHaveBeenCalledOnce();
        expect(options.playSong).not.toHaveBeenCalled();
    });

    it('reports an actually empty restored queue instead of waiting or inventing a song', async () => {
        const { handler, options } = mount();
        fixture.state.currentSong = null;
        await expect(handler({ action: 'resume' })).rejects.toThrow('NO_ACTIVE_TRACK');
        expect(options.resume).not.toHaveBeenCalled();
    });

    it('does not call play on an empty audio source after restoration failed', async () => {
        const { handler, options } = mount();
        fixture.state.audioSrc = null;
        await expect(handler({ action: 'resume' })).rejects.toThrow('status.playbackSourceUnconfirmed');
        expect(options.resume).not.toHaveBeenCalled();
    });

    it.each(['pause', 'stop', 'unmount'])('a pending cold resume cannot override %s', async action => {
        vi.useFakeTimers();
        const { handler, options } = mount();
        options.playbackReady = false;
        const pending = expect(handler({ action: 'resume' })).rejects.toThrow('status.playbackRequestSuperseded');
        if (action === 'unmount') fixture.cleanups.splice(0).forEach(cleanup => cleanup());
        else await handler({ action });
        options.playbackReady = true;
        await vi.advanceTimersByTimeAsync(50);
        await pending;
        expect(options.resume).not.toHaveBeenCalled();
    });

    it('times out before the host receipt deadline and never plays later in the background', async () => {
        vi.useFakeTimers();
        const { handler, options } = mount();
        options.playbackReady = false;
        const pending = expect(handler({ action: 'resume' })).rejects.toThrow('status.playbackRestorePending');
        await vi.advanceTimersByTimeAsync(20_000);
        await pending;
        options.playbackReady = true;
        await vi.advanceTimersByTimeAsync(500);
        expect(options.resume).not.toHaveBeenCalled();
    });
});

describe('Harbour shuffle transport', () => {
    it('delegates once to Folia and returns its authoritative queue without playback commands', async () => {
        const { handler, options } = mount();
        expect((await handler({ action: 'status' })).shuffleAvailable).toBe(true);
        const result = await handler({ action: 'shuffle' });
        expect(result.accepted).toBe(true);
        expect(result.tracks.map((track: any) => track.id)).toEqual(['1', '3', '2']);
        expect(result.currentTrackId).toBe('1');
        expect(options.shuffleQueue).toHaveBeenCalledTimes(1);
        for (const method of ['playSong', 'resume', 'pause', 'next', 'previous'] as const) expect(options[method]).not.toHaveBeenCalled();
    });
    it.each([0, 1])('rejects a %i-song queue without reporting success', async size => {
        fixture.state.playQueue = fixture.state.playQueue.slice(0, size);
        const { handler, options } = mount();
        expect((await handler({ action: 'queue' })).shuffleAvailable).toBe(false);
        await expect(handler({ action: 'shuffle' })).rejects.toThrow('status.shuffleNeedsQueue');
        expect(options.shuffleQueue).not.toHaveBeenCalled();
    });
    it.each(['fm', 'stage'])('respects %s queue ownership', async mode => {
        fixture.state.isFmMode = mode === 'fm';
        const { handler, options } = mount(mode === 'stage');
        expect((await handler({ action: 'status' })).shuffleAvailable).toBe(false);
        await expect(handler({ action: 'shuffle' })).rejects.toThrow('status.shuffleUnavailable');
        expect(options.shuffleQueue).not.toHaveBeenCalled();
    });
    it('checks the live queue at execution time, not the last published availability', async () => {
        const { handler, options } = mount();
        fixture.state.playQueue = [];
        await expect(handler({ action: 'shuffle' })).rejects.toThrow('status.shuffleNeedsQueue');
        expect(options.shuffleQueue).not.toHaveBeenCalled();
    });
});

describe('Harbour live music subscription', () => {
    it('coalesces direct Folia selection and accepts asynchronous lyrics without polling or commands', async () => {
        const { publish, options } = mount(); publish.mockClear();
        updatePlayback({ currentSong: fixture.state.playQueue[1], lyrics: null });
        updatePlayback({ playerState: 'PLAYING' });
        expect(publish).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ currentTrackId: '2', paused: false }));
        updatePlayback({ lyrics: { lines: [{ startTime: 0, endTime: 10, fullText: 'Local fixture line', words: [] }] } });
        await Promise.resolve();
        expect(publish).toHaveBeenCalledTimes(2);
        expect(publish.mock.lastCall?.[0].lyrics).toMatchObject({ trackId: '2', status: 'ready' });
        expectNoTransport(options);
    });
    it('does not publish a queued store change after unmount', async () => {
        const { publish } = mount(); publish.mockClear();
        updatePlayback({ playerState: 'PLAYING' });
        fixture.cleanups.splice(0).forEach(cleanup => cleanup());
        await Promise.resolve();
        expect(publish).not.toHaveBeenCalled(); expect(fixture.playbackListeners.size).toBe(0);
    });
});

describe('Harbour explicit play confirmation', () => {
    it('rejects the real reported shape: requested Baiyang but a different old track remains IDLE', async () => {
        fixture.state.currentSong = { id: 'online:qq:0034QXzv2ptMdw', name: 'Old track' };
        fixture.state.audioSrc = 'https://audio.test/old.mp3';
        fixture.state.playerState = 'IDLE';
        const target = { id: 'online:qq:0016aHoC1IyI1d', name: '白羊' };
        const { handler, options } = mount();
        fixture.search.mockResolvedValue({ items: [target] });
        await handler({ action: 'search', query: '白羊', source: 'qq' });
        options.playSong.mockImplementation(async () => { fixture.status = { type: 'error', text: 'No playback link' }; });
        await expect(handler({ action: 'play', trackId: target.id })).rejects.toThrow('No playback link');
        expect(options.playSong).toHaveBeenCalledOnce();
        expect(fixture.state.currentSong.id).toBe('online:qq:0034QXzv2ptMdw');
        expect(fixture.playbackListeners.size).toBe(1); // only the mounted transport subscription remains
    });

    it('rejects a same-song reload failure even when the prior source is still loaded', async () => {
        fixture.state.audioSrc = 'https://audio.test/old.mp3';
        const { handler, options } = mount();
        options.playSong.mockImplementation(async () => { fixture.status = { type: 'error', text: 'Login required' }; });
        await expect(handler({ action: 'play', trackId: '1' })).rejects.toThrow('Login required');
        expect(fixture.playbackListeners.size).toBe(1);
    });

    it.each([null, '', '   '])('rejects a selected track without an audio source (%j)', async audioSrc => {
        fixture.status = { type: 'error', text: 'Old unrelated error' };
        const { handler, options } = mount();
        options.playSong.mockImplementation(async (song: unknown) => updatePlayback({ currentSong: song, audioSrc }));
        await expect(handler({ action: 'play', trackId: '2' })).rejects.toThrow('status.playbackSourceUnconfirmed');
        expect(fixture.playbackListeners.size).toBe(1);
    });

    it.each(['IDLE', 'PAUSED', 'PLAYING'])('confirms only the loaded source and preserves the authoritative %s status', async playerState => {
        const { handler, options } = mount();
        options.playSong.mockImplementation(async (song: unknown) => updatePlayback({ currentSong: song, audioSrc: 'https://audio.test/new.mp3', playerState }));
        expect(await handler({ action: 'play', trackId: '2' })).toMatchObject({
            accepted: true, playbackConfirmation: 'source-loaded', currentTrackId: '2', playbackStatus: playerState, paused: playerState !== 'PLAYING',
        });
        expect(fixture.playbackListeners.size).toBe(1);
    });

    it('does not attribute an unrelated toast to a successfully selected new source', async () => {
        const { handler, options } = mount();
        options.playSong.mockImplementation(async (song: unknown) => {
            updatePlayback({ currentSong: song, audioSrc: 'https://audio.test/new.mp3' });
            fixture.status = { type: 'error', text: 'Unrelated operation failed' };
        });
        expect(await handler({ action: 'play', trackId: '2' })).toMatchObject({ accepted: true, playbackConfirmation: 'source-loaded' });
    });

    it('reports a subsequent direct Folia selection as superseded, not as an audio failure', async () => {
        let finish!: () => void;
        const { handler, options } = mount();
        options.playSong.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
        const pending = handler({ action: 'play', trackId: '2' });
        const assertion = expect(pending).rejects.toThrow('status.playbackRequestSuperseded');
        updatePlayback({ currentSong: fixture.state.playQueue[2], audioSrc: 'https://audio.test/third.mp3' });
        finish();
        await assertion;
        expect(fixture.state.currentSong.id).toBe(3);
        expect(fixture.playbackListeners.size).toBe(1);
    });

    it('does not accept an older command after a newer pause request or overwrite its state', async () => {
        let finish!: () => void;
        const { handler, options } = mount();
        options.playSong.mockImplementation((song: unknown) => {
            updatePlayback({ currentSong: song, audioSrc: 'https://audio.test/new.mp3' });
            return new Promise<void>(resolve => { finish = resolve; });
        });
        const pending = handler({ action: 'play', trackId: '2' });
        const assertion = expect(pending).rejects.toThrow('status.playbackRequestSuperseded');
        await handler({ action: 'pause' });
        finish(); await assertion;
        expect(options.pause).toHaveBeenCalledOnce();
        expect(options.playSong).toHaveBeenCalledOnce();
        expect(fixture.playbackListeners.size).toBe(1);
    });

    it('always unsubscribes when the underlying operation throws', async () => {
        const { handler, options } = mount();
        options.playSong.mockRejectedValue(new Error('Fixture failure'));
        await expect(handler({ action: 'play', trackId: '2' })).rejects.toThrow('Fixture failure');
        expect(fixture.playbackListeners.size).toBe(1);
    });
});

describe('Harbour explicit play-next transport', () => {
    it('delegates the live canonical song to the shared queue action, without playing or replacing the queue', async () => {
        const { handler, options } = mount();
        const target = fixture.state.playQueue[1];
        fixture.search.mockResolvedValueOnce({ items: [{ ...target, name: 'stale search metadata' }] });
        await handler({ action: 'search', query: 'song', source: 'qq' });
        const before = fixture.state.playQueue;
        expect(await handler({ action: 'play_next', trackId: '2' })).toMatchObject({ accepted: true, currentTrackId: '1', playNextAvailable: true });
        expect(options.playSongNext).toHaveBeenCalledExactlyOnceWith(target);
        expect(fixture.state.playQueue).toBe(before);
        for (const method of ['playSong', 'addOnlineSongToQueue', 'resume', 'pause', 'next', 'previous', 'shuffleQueue'] as const) {
            expect(options[method]).not.toHaveBeenCalled();
        }
    });

    it('resolves a searched song and a local library song not already in the playback queue', async () => {
        const { handler, options } = mount();
        const target = { id: 'searched', name: 'Searched' };
        fixture.search.mockResolvedValueOnce({ items: [target] });
        await handler({ action: 'search', query: 'song', source: 'qq' });
        await handler({ action: 'play_next', trackId: 'searched' });
        expect(options.playSongNext).toHaveBeenLastCalledWith(target);
        options.localSongs.push({ id: 'local-song', title: 'Local' });
        await handler({ action: 'play_next', trackId: 'local-song' });
        expect(options.playSongNext).toHaveBeenLastCalledWith({ id: 'local-song', name: 'Local' });
    });

    it('never accepts a rejected shared operation or falls back to play/enqueue', async () => {
        const { handler, options, publish } = mount();
        options.playSongNext.mockImplementation(() => { throw new Error('status.playNextUnavailable'); });
        publish.mockClear();
        await expect(handler({ action: 'play_next', trackId: '2' })).rejects.toThrow('status.playNextUnavailable');
        expect(publish).not.toHaveBeenCalled();
        expect(options.playSong).not.toHaveBeenCalled();
        expect(options.addOnlineSongToQueue).not.toHaveBeenCalled();
        expect(options.resume).not.toHaveBeenCalled();
    });

    it.each([undefined, '', 'missing'])('rejects unresolved trackId %s without any playback action', async trackId => {
        const { handler, options } = mount();
        await expect(handler({ action: 'play_next', trackId })).rejects.toThrow();
        expectNoTransport(options);
    });

    it('publishes availability from the same live capability getter, not the initial snapshot', async () => {
        const { handler, options } = mount();
        expect(await handler({ action: 'status' })).toMatchObject({ playNextAvailable: true });
        options.canPlaySongNext.mockReturnValue(false);
        expect(await handler({ action: 'status' })).toMatchObject({ playNextAvailable: false });
        options.canPlaySongNext.mockReturnValue(true);
        expect(await handler({ action: 'queue' })).toMatchObject({ playNextAvailable: true });
        expectNoTransport(options);
    });
});

describe('Harbour playback mode transport', () => {
    it.each(['off', 'all', 'one', 'shuffle'])('sets %s on the native audio store and returns the authoritative mode', async playbackMode => {
        const { handler, options, publish } = mount();
        const result = await handler({ action: 'set_playback_mode', playbackMode });
        expect(fixture.audioState.setLoopMode).toHaveBeenCalledExactlyOnceWith(playbackMode);
        expect(result).toMatchObject({ accepted: true, playbackMode, playbackModeAvailable: true, currentTrackId: '1' });
        expect((await handler({ action: 'status' })).playbackMode).toBe(playbackMode);
        expect(result.tracks.map((track: any) => track.id)).toEqual(['1', '2', '3']);
        expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ playbackMode }));
        expectNoTransport(options);
    });

    it('publishes mode and volume changes immediately, but not unrelated quality changes', () => {
        const { publish, options } = mount();
        publish.mockClear();
        updateAudioSettings({ loopMode: 'shuffle' });
        expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ playbackMode: 'shuffle', playbackModeAvailable: true }));
        updateAudioSettings({ audioQuality: '128' });
        updateAudioSettings({ loopMode: 'shuffle' });
        expect(publish).toHaveBeenCalledTimes(1);
        updateAudioSettings({ volume: 0.3 });
        expect(publish).toHaveBeenCalledTimes(2);
        expectNoTransport(options);
    });

    it('unsubscribes mode changes and command handlers when the bridge unmounts', () => {
        const { publish, unsubscribeCommand } = mount();
        expect(fixture.modeListeners.size).toBe(1);
        fixture.cleanups.splice(0).forEach(cleanup => cleanup());
        expect(fixture.modeListeners.size).toBe(0);
        expect(fixture.unsubscribeMode).toHaveBeenCalledTimes(1);
        expect(unsubscribeCommand).toHaveBeenCalledTimes(1);
        publish.mockClear();
        updateAudioSettings({ loopMode: 'shuffle' });
        expect(publish).not.toHaveBeenCalled();
    });

    it.each([undefined, null, '', 'random', 1, {}, ['shuffle']])('rejects an invalid mode %j without mutating settings or audio', async playbackMode => {
        const { handler, options } = mount();
        await expect(handler({ action: 'set_playback_mode', playbackMode })).rejects.toThrow('INVALID_PLAYBACK_MODE');
        expect(fixture.audioState.loopMode).toBe('off');
        expect(fixture.audioState.setLoopMode).not.toHaveBeenCalled();
        expectNoTransport(options);
    });

    it.each(['fm', 'stage'])('rejects mode control for %s ownership', async mode => {
        fixture.state.isFmMode = mode === 'fm';
        const { handler, options } = mount(mode === 'stage');
        expect((await handler({ action: 'status' })).playbackModeAvailable).toBe(false);
        await expect(handler({ action: 'set_playback_mode', playbackMode: 'shuffle' })).rejects.toThrow('status.shuffleUnavailable');
        expect(fixture.audioState.setLoopMode).not.toHaveBeenCalled();
        expectNoTransport(options);
    });

    it('checks live FM ownership instead of trusting the last published availability', async () => {
        const { handler, options } = mount();
        expect((await handler({ action: 'status' })).playbackModeAvailable).toBe(true);
        fixture.state.isFmMode = true;
        await expect(handler({ action: 'set_playback_mode', playbackMode: 'shuffle' })).rejects.toThrow('status.shuffleUnavailable');
        expect(fixture.audioState.setLoopMode).not.toHaveBeenCalled();
        expectNoTransport(options);
    });

    it('allows an empty queue to configure a future mode without playing, shuffling or seeking', async () => {
        fixture.state.playQueue = [];
        fixture.state.currentSong = null;
        const { handler, options } = mount();
        const result = await handler({ action: 'set_playback_mode', playbackMode: 'shuffle' });
        expect(result).toMatchObject({ accepted: true, loaded: false, playbackMode: 'shuffle', playbackModeAvailable: true, shuffleAvailable: false, tracks: [] });
        expectNoTransport(options);
    });
});
