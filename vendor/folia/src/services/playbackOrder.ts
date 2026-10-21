import type { SongResult, StageLoopMode } from '../types';
import { useAudioSettingsStore } from '../stores/useAudioSettingsStore';
import { insertNextShuffleOrderKeys, resolvePlaybackOrder } from '../utils/playbackOrder';

// Stateful adapter shared by transport, prefetch and explicit queue edits.
export const getPlaybackOrder = (queue: SongResult[], mode: StageLoopMode): SongResult[] => {
    const state = useAudioSettingsStore.getState();
    return resolvePlaybackOrder(queue, mode, { seed: state.shuffleSeed, orderKeys: state.shuffleOrderKeys });
};

export const getPlaybackOrderRevision = (): number => useAudioSettingsStore.getState().shuffleRevision;

export const registerShuffleInsertNext = (
    currentSong: SongResult | null,
    insertedSongs: SongResult[],
    canonicalQueue: SongResult[],
): void => {
    const state = useAudioSettingsStore.getState();
    if (state.loopMode !== 'shuffle' || insertedSongs.length === 0) return;
    const order = getPlaybackOrder(canonicalQueue, 'shuffle');
    state.setShuffleOrderKeys(insertNextShuffleOrderKeys(order, currentSong, insertedSongs));
};
