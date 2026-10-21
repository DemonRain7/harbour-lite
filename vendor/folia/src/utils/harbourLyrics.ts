import type { LyricData } from '../types';
import { findLatestActiveLineIndex } from './appPlaybackHelpers';

// A bounded, already-parsed lyric window for Harbour's lightweight companion.
// No provider requests, raw LRC, word arrays or second lyric clock cross this bridge.
export function createHarbourLyrics() {
    let previousTrack = '', previousLyrics: LyricData | null = null;
    let staleLyrics: LyricData | null = null;
    return (trackId: string, lyrics: LyricData | null, time: number, offsetMs: number, transitioning = false) => {
        if (trackId !== previousTrack && previousTrack) staleLyrics = previousLyrics;
        if (lyrics !== staleLyrics) staleLyrics = null;
        previousTrack = trackId; previousLyrics = lyrics;
        const base = { trackId, clockMs: Math.round(time * 1000 - (Number.isFinite(offsetMs) ? offsetMs : 0)) };
        if (transitioning) return { ...base, status: 'switching', lines: [] };
        if (!trackId || !lyrics || lyrics === staleLyrics || !lyrics.lines.length) return { ...base, status: 'empty', lines: [] };
        const clock = base.clockMs / 1000;
        const active = findLatestActiveLineIndex(lyrics.lines, clock);
        const upcoming = lyrics.lines.findIndex(line => line.startTime > clock);
        const center = active >= 0 ? active : upcoming >= 0 ? upcoming : lyrics.lines.length - 1;
        const start = Math.max(0, center - 1);
        const lines = lyrics.lines.slice(start, start + 6).map((line, i) => ({
            index: start + i, startMs: Math.round(line.startTime * 1000),
            endMs: Math.round((line.renderHints?.renderEndTime ?? line.endTime) * 1000),
            text: line.fullText.slice(0, 500), translation: (line.translation || '').slice(0, 500),
        }));
        return { ...base, status: 'ready', lines };
    };
}
