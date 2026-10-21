import type { SongResult, StageLoopMode } from '../types';
import { getPlaybackSongKey } from './appPlaybackGuards';

// Pure playback ordering: the library queue never changes when a playback mode changes.
export type ShuffleOrderState = { seed: number; orderKeys: readonly string[] };
const EMPTY_KEYS: readonly string[] = Object.freeze([]);
const DEFAULT_STATE: ShuffleOrderState = { seed: 1, orderKeys: EMPTY_KEYS };
type CachedOrder = { seed: number; keys: readonly string[]; order: SongResult[] };
const orderCache = new WeakMap<SongResult[], CachedOrder>();

const randomRank = (key: string, seed: number): number => {
    let value = (2166136261 ^ seed) >>> 0;
    for (let index = 0; index < key.length; index += 1) {
        value = Math.imul(value ^ key.charCodeAt(index), 16777619);
    }
    value ^= value >>> 16;
    value = Math.imul(value, 0x7feb352d);
    value ^= value >>> 15;
    value = Math.imul(value, 0x846ca68b);
    return (value ^ (value >>> 16)) >>> 0;
};

/** Stable across metadata clones; identical queue/state references return the cached array. */
export const resolvePlaybackOrder = (
    queue: SongResult[],
    mode: StageLoopMode,
    state: ShuffleOrderState = DEFAULT_STATE,
): SongResult[] => {
    if (mode !== 'shuffle' || queue.length < 2) return queue;
    const cached = orderCache.get(queue);
    if (cached?.seed === state.seed && cached.keys === state.orderKeys) return cached.order;

    const ranks = new Map(state.orderKeys.map((key, index) => [key, index]));
    const ordered = queue.map((song, index) => {
        const key = getPlaybackSongKey(song);
        return { song, index, key, priority: ranks.get(key) ?? Infinity, rank: randomRank(key, state.seed) };
    }).sort((left, right) => (
        (left.priority !== right.priority ? left.priority - right.priority : 0)
        || left.rank - right.rank
        || (left.key < right.key ? -1 : left.key > right.key ? 1 : left.index - right.index)
    )).map(entry => entry.song);
    orderCache.set(queue, { seed: state.seed, keys: state.orderKeys, order: ordered });
    return ordered;
};

/** Explicit “play next” edits the common random order, not a separate next-only override. */
export const insertNextShuffleOrderKeys = (
    order: SongResult[],
    currentSong: SongResult | null,
    insertedSongs: SongResult[],
): string[] => {
    const keys = [...new Set(order.map(getPlaybackSongKey))];
    const present = new Set(keys);
    const currentKey = currentSong ? getPlaybackSongKey(currentSong) : null;
    const inserted = [...new Set(insertedSongs.map(getPlaybackSongKey))]
        .filter(key => present.has(key) && key !== currentKey);
    const moving = new Set(inserted);
    const remaining = keys.filter(key => !moving.has(key));
    const anchor = currentKey ? remaining.indexOf(currentKey) : -1;
    remaining.splice(anchor + 1, 0, ...inserted);
    return remaining;
};

export const isWrappingPlaybackMode = (mode: StageLoopMode): boolean => mode === 'all' || mode === 'shuffle';
