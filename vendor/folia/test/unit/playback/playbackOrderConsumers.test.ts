import { describe, expect, it } from 'vitest';
import type { SongResult } from '@/types';
import { PlayerState } from '@/types';
import { resolvePlaybackOrder, insertNextShuffleOrderKeys } from '@/utils/playbackOrder';
import { resolvePlaybackNeighbors } from '@/utils/playbackNeighbors';
import { resolveNextUpTrack } from '@/components/app/overlays/now-playing-toast/resolveNextUpTrack';
import { resolveNextQueueSong } from '@/services/automix/useAutomixDecks';
import { buildPlaybackSyncBridgeModel, buildRemoteControlSnapshotFromPlaybackSyncBridge } from '@/utils/playbackSyncBridge';
import { getPlaybackSongKey } from '@/utils/appPlaybackGuards';

// All discrete next-track consumers agree without mutating the canonical queue or playing audio.
const queue: SongResult[] = Array.from({ length: 9 }, (_, id) => ({
    id, name: `Song ${id}`, artists: [], album: { id: 1, name: 'Album' }, durationMs: 1000,
}));
const state = { seed: 39141, orderKeys: [] as string[] };
const exportState = { status: 'idle', presetId: null, progress: 0, elapsed: 0, duration: 0, countdown: null, filePath: null, error: null } as const;

function assertConsumers(order: SongResult[], canonical = queue) {
    order.forEach((song, index) => {
        const next = order[(index + 1) % order.length];
        const previous = order[(index - 1 + order.length) % order.length];
        const neighbors = resolvePlaybackNeighbors({ playQueue: order, currentSong: song, loopMode: 'shuffle', isFmMode: false, isStageActive: false });
        expect(neighbors.next.key).toBe(getPlaybackSongKey(next));
        expect(neighbors.prev.key).toBe(getPlaybackSongKey(previous));
        expect(resolveNextUpTrack({ playQueue: order, song, loopMode: 'shuffle', isFmMode: false, isStageActive: false })).toBe(next);
        expect(resolveNextQueueSong(order, song, 'shuffle')).toBe(next);
        const model = buildPlaybackSyncBridgeModel({
            activePlaybackContext: 'main', currentSong: song, playQueue: canonical, playbackOrder: order,
            currentTimeSec: 30, durationSec: 180, playerState: PlayerState.PLAYING, coverUrl: null,
            effectiveLoopMode: 'shuffle', isFmMode: false, isStageActive: false, controlsDisabled: false,
            transparentModeEnabled: false, mainWindowClickThroughEnabled: false, mainWindowBorderVisible: true,
            playerChromeHidden: false, exportState, isDaylight: false, isLiked: false, mainWindowWidth: 1280, mainWindowHeight: 720,
        });
        const remote = buildRemoteControlSnapshotFromPlaybackSyncBridge(model, { playerChromeVisibilityMode: 'auto-hide' });
        expect(remote.nextTrackKey).toBe(neighbors.next.key);
        expect(remote.prevTrackKey).toBe(neighbors.prev.key);
        expect(remote.canGoNext && remote.canGoPrevious).toBe(true);
        expect(model.playQueue).toBe(canonical);
        expect(model.currentIndex).toBe(canonical.indexOf(song));
    });
}

describe('shared random playback consumers', () => {
    it('keeps previews, remote navigation and Automix aligned through a complete cycle', () => {
        assertConsumers(resolvePlaybackOrder(queue, 'shuffle', state));
    });
    it('all follow explicit next insertion and metadata changes', () => {
        const canonical = [...queue, { ...queue[0], id: 999, name: 'Inserted' }];
        const initial = resolvePlaybackOrder(canonical, 'shuffle', state);
        const current = initial[2];
        const inserted = canonical.at(-1)!;
        const edited = { ...state, orderKeys: insertNextShuffleOrderKeys(initial, current, [inserted]) };
        const order = resolvePlaybackOrder(canonical, 'shuffle', edited);
        expect(order[order.indexOf(current) + 1]).toBe(inserted);
        assertConsumers(order, canonical);
        const refreshed = canonical.map(song => ({ ...song, name: `${song.name} refreshed` }));
        assertConsumers(resolvePlaybackOrder(refreshed, 'shuffle', edited), refreshed);
    });
    it('empty and single-track Automix do not invent a transition', () => {
        expect(resolveNextQueueSong([], queue[0], 'shuffle')).toBeNull();
        expect(resolveNextQueueSong([queue[0]], queue[0], 'shuffle')).toBeNull();
    });
});
