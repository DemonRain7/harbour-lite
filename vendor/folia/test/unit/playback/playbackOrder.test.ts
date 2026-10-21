import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SongResult } from '@/types';
import { getPlaybackSongKey } from '@/utils/appPlaybackGuards';
import { insertNextShuffleOrderKeys, isWrappingPlaybackMode, resolvePlaybackOrder } from '@/utils/playbackOrder';

// Random playback is a stable navigation order, not a mutation of the library queue.
const song = (id: number, providerId: 'qq' | 'netease' = 'qq'): SongResult => ({
    id, name: `Song ${id}`, artists: [], album: { id: 1, name: 'Album' }, durationMs: 1000,
    sourceRef: { kind: 'online', providerId, mediaId: String(id) },
});
const queue = Array.from({ length: 24 }, (_, index) => song(index));
const keys = (songs: SongResult[]) => songs.map(getPlaybackSongKey);
const state = { seed: 71234, orderKeys: [] as string[] };

describe('shared shuffle playback order', () => {
    it('does not change canonical order and visits every item once per cycle', () => {
        const before = keys(queue);
        const order = resolvePlaybackOrder(queue, 'shuffle', state);
        expect(keys(queue)).toEqual(before);
        expect(keys(order)).not.toEqual(before);
        expect(new Set(keys(order)).size).toBe(queue.length);
        expect(new Set(keys(order))).toEqual(new Set(before));
        expect(resolvePlaybackOrder(queue, 'off', state)).toBe(queue);
        expect(resolvePlaybackOrder(queue, 'all', state)).toBe(queue);
        expect(resolvePlaybackOrder(queue, 'one', state)).toBe(queue);
    });

    it('memoizes the hot path and keeps order when metadata objects are replaced', () => {
        const order = resolvePlaybackOrder(queue, 'shuffle', state);
        expect(resolvePlaybackOrder(queue, 'shuffle', { ...state })).toBe(order);
        const cloned = queue.map(item => ({ ...item, name: `${item.name} updated` }));
        const refreshed = resolvePlaybackOrder(cloned, 'shuffle', state);
        expect(keys(refreshed)).toEqual(keys(order));
        expect(refreshed.every(item => item.name.endsWith('updated'))).toBe(true);
        expect(keys(resolvePlaybackOrder(queue, 'shuffle', { ...state, seed: 12 }))).not.toEqual(keys(order));
    });

    it('retains provider identity and includes every queue entry', () => {
        const mixed = [song(1, 'qq'), song(1, 'netease'), song(2, 'qq')];
        expect(new Set(keys(resolvePlaybackOrder(mixed, 'shuffle', state))).size).toBe(3);
    });

    it('inserts explicit next tracks into the same order used for forward and backward navigation', () => {
        const before = resolvePlaybackOrder(queue, 'shuffle', state);
        const current = before[4];
        const inserted = [before[18], before[12]];
        const orderKeys = insertNextShuffleOrderKeys(before, current, inserted);
        const after = resolvePlaybackOrder(queue, 'shuffle', { ...state, orderKeys });
        const index = after.indexOf(current);
        expect(after.slice(index + 1, index + 3)).toEqual(inserted);
        expect(after[after.indexOf(inserted[0]) - 1]).toBe(current);
        expect(after[after.indexOf(inserted[1]) - 1]).toBe(inserted[0]);
        expect(new Set(keys(after)).size).toBe(queue.length);
        expect(keys(queue)).toEqual(Array.from({ length: 24 }, (_, index) => getPlaybackSongKey(song(index))));
    });

    it('reconciles removals and new songs without reshuffling retained entries', () => {
        const before = resolvePlaybackOrder(queue, 'shuffle', state);
        const orderKeys = insertNextShuffleOrderKeys(before, before[4], [before[18]]);
        const removed = queue[0];
        const nextQueue = [...queue.filter(item => item !== removed), song(100)];
        const after = resolvePlaybackOrder(nextQueue, 'shuffle', { ...state, orderKeys });
        expect(keys(after.slice(0, -1))).toEqual(orderKeys.filter(key => key !== getPlaybackSongKey(removed)));
        expect(after.at(-1)?.id).toBe(100);
    });

    it('handles empty, single-item, missing-anchor and repeated insert requests safely', () => {
        expect(resolvePlaybackOrder([], 'shuffle', state)).toEqual([]);
        const single = [queue[0]];
        expect(resolvePlaybackOrder(single, 'shuffle', state)).toBe(single);
        const orderKeys = insertNextShuffleOrderKeys(queue, null, [queue[3], queue[3], song(99)]);
        expect(orderKeys[0]).toBe(getPlaybackSongKey(queue[3]));
        expect(orderKeys.length).toBe(queue.length);
        expect(isWrappingPlaybackMode('shuffle')).toBe(true);
        expect(isWrappingPlaybackMode('one')).toBe(false);
    });
});

describe('persisted shared playback mode', () => {
    beforeEach(() => {
        vi.resetModules();
        const values = new Map<string, string>();
        const storage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
            removeItem: (key: string) => values.delete(key),
        };
        vi.stubGlobal('window', { localStorage: storage });
        vi.stubGlobal('localStorage', storage);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('persists mode, seed and explicit next order across imports without reshuffling on a repeated command', async () => {
        const { useAudioSettingsStore } = await import('@/stores/useAudioSettingsStore');
        const { getPlaybackOrder, registerShuffleInsertNext } = await import('@/services/playbackOrder');
        useAudioSettingsStore.getState().setLoopMode('shuffle');
        const seed = useAudioSettingsStore.getState().shuffleSeed;
        const initial = getPlaybackOrder(queue, 'shuffle');
        registerShuffleInsertNext(initial[3], [initial[15]], queue);
        const final = keys(getPlaybackOrder(queue, 'shuffle'));
        useAudioSettingsStore.getState().setLoopMode('shuffle');
        expect(useAudioSettingsStore.getState().shuffleSeed).toBe(seed);
        expect(keys(getPlaybackOrder(queue, 'shuffle'))).toEqual(final);
        vi.resetModules();
        const restored = await import('@/stores/useAudioSettingsStore');
        const service = await import('@/services/playbackOrder');
        expect(restored.useAudioSettingsStore.getState().loopMode).toBe('shuffle');
        expect(restored.useAudioSettingsStore.getState().shuffleSeed).toBe(seed);
        expect(keys(service.getPlaybackOrder(queue, 'shuffle'))).toEqual(final);
        restored.useAudioSettingsStore.getState().setLoopMode('off');
        expect(service.getPlaybackOrder(queue, 'off')).toBe(queue);
        restored.useAudioSettingsStore.getState().setLoopMode('shuffle');
        expect(restored.useAudioSettingsStore.getState().shuffleSeed).not.toBe(seed);
        expect(restored.useAudioSettingsStore.getState().shuffleOrderKeys).toEqual([]);
    });

    it('ignores malformed optional persisted ordering', async () => {
        localStorage.setItem('folia_shuffle_order_v1', '{broken');
        const { useAudioSettingsStore } = await import('@/stores/useAudioSettingsStore');
        expect(useAudioSettingsStore.getState().shuffleOrderKeys).toEqual([]);
        expect(useAudioSettingsStore.getState().shuffleSeed).toBe(1);
    });
});
