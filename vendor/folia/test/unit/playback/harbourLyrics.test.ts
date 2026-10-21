import { describe, expect, it } from 'vitest';
import { createHarbourLyrics } from '../../../src/utils/harbourLyrics';
import type { LyricData } from '../../../src/types';

// The companion consumes the same parsed line/timing data, never raw providers.
const data: LyricData = { lines: Array.from({ length: 100 }, (_, index) => ({ startTime: index * 4, endTime: index * 4 + 3,
    fullText: `Lyric ${index}`, translation: `译文 ${index}`, words: [] })) };
describe('Harbour lyric projection', () => {
    it('exports a bounded neighborhood, preserving translation, offset and render hints', () => {
        const read = createHarbourLyrics();
        const view = read('one', data, 11, 2000);
        expect(view.status).toBe('ready'); expect(view.clockMs).toBe(9000);
        expect(view.lines).toHaveLength(6); expect(view.lines[0].index).toBe(1);
        expect(view.lines[1]).toMatchObject({ index: 2, text: 'Lyric 2', translation: '译文 2', startMs: 8000, endMs: 11000 });
        expect(JSON.stringify(view)).not.toContain('words');
        expect(read('one', { lines: [{ ...data.lines[0], renderHints: { renderEndTime: 6 } as any }] }, 5, 0).lines[0].endMs).toBe(6000);
    });
    it('handles prelude, gap, end and absent lyrics without assigning a made-up active line', () => {
        const read = createHarbourLyrics();
        expect(read('one', data, 0, 2000).clockMs).toBe(-2000);
        expect(read('one', data, 3.5, 0).lines[0].index).toBe(0);
        expect(read('one', data, 800, 0).lines.at(-1)?.index).toBe(99);
        expect(read('one', null, 0, 0).status).toBe('empty');
    });
    it('clears a previous song and accepts late fresh lyrics without another command', () => {
        const read = createHarbourLyrics(); read('one', data, 10, 0);
        expect(read('two', data, 0, 0).lines).toEqual([]);
        expect(read('two', data, 1, 0).status).toBe('empty');
        const fresh = { lines: [{ ...data.lines[0], fullText: 'second song' }] };
        expect(read('two', fresh, 2, 0).lines[0].text).toBe('second song');
        expect(read('two', fresh, 2, 0, true).status).toBe('switching');
        expect(read('two', fresh, 2, 0, false).status).toBe('ready');
    });
});
