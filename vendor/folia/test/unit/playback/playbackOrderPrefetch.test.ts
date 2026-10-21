import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SongResult } from '@/types';
import { getPlaybackSongKey } from '@/utils/appPlaybackGuards';

// Verify prefetch uses the transport's random order without issuing provider or audio requests.
const scope = vi.hoisted(() => vi.fn());
vi.mock('@/services/automix/profileService', () => ({ setAnalysisScope: scope, ensureTrackProfile: vi.fn() }));
import { prefetchNearbySongs, clearPrefetchRuntime } from '@/services/prefetchService';
import { useAudioSettingsStore } from '@/stores/useAudioSettingsStore';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { getPlaybackOrder } from '@/services/playbackOrder';

const queue: SongResult[] = Array.from({ length: 8 }, (_, id) => ({
    id, name: `Song ${id}`, artists: [], album: { id: 1, name: 'Album' }, durationMs: 1000,
    sourceRef: { kind: 'online', providerId: 'qq', mediaId: String(id) },
}));

describe('playback-order-aware prefetch', () => {
    beforeEach(() => {
        scope.mockClear();
        // Work is scheduled but deliberately not executed: this test cannot use real provider APIs.
        vi.stubGlobal('requestIdleCallback', vi.fn());
        vi.stubGlobal('window', { requestIdleCallback });
        useAudioSettingsStore.setState({ loopMode: 'shuffle', shuffleSeed: 451, shuffleOrderKeys: [] });
        usePlaybackStore.setState({ isFmMode: false });
    });
    afterEach(() => {
        clearPrefetchRuntime();
        vi.unstubAllGlobals();
        useAudioSettingsStore.setState({ loopMode: 'off', shuffleSeed: 1, shuffleOrderKeys: [] });
        usePlaybackStore.setState({ isFmMode: false });
    });

    it('prefetches the same next random track and keeps canonical queue unchanged', async () => {
        const original = queue.map(getPlaybackSongKey);
        const order = getPlaybackOrder(queue, 'shuffle');
        await prefetchNearbySongs(order[3], queue, 'high');
        expect(scope).toHaveBeenLastCalledWith([order[3], order[4]]);
        expect(queue.map(getPlaybackSongKey)).toEqual(original);
        expect(requestIdleCallback).toHaveBeenCalledOnce();
    });

    it('warms the wrap target at the end of a random cycle', async () => {
        const order = getPlaybackOrder(queue, 'shuffle');
        await prefetchNearbySongs(order.at(-1)!, queue, 'high');
        expect(scope).toHaveBeenLastCalledWith([order.at(-1), order[0]]);
    });

    it('does not shuffle or wrap FM and allows an explicit sequential restore mode', async () => {
        usePlaybackStore.setState({ isFmMode: true });
        await prefetchNearbySongs(queue[3], queue, 'high');
        expect(scope).toHaveBeenLastCalledWith([queue[3], queue[4]]);
        await prefetchNearbySongs(queue.at(-1)!, queue, 'high');
        expect(scope).toHaveBeenLastCalledWith([queue.at(-1)]);
        usePlaybackStore.setState({ isFmMode: false });
        await prefetchNearbySongs(queue[3], queue, 'high', undefined, 'off');
        expect(scope).toHaveBeenLastCalledWith([queue[3], queue[4]]);
    });
});
