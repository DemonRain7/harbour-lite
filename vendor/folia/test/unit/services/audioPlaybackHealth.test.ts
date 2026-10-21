import { describe, expect, it } from 'vitest';
import { createAudioPlaybackHealth } from '../../../src/services/audioPlaybackHealth';

const media = (ranges: number[][] = [[0, 120]]) => Object.assign(new EventTarget(), {
    buffered: { length: ranges.length, start: (i: number) => ranges[i][0], end: (i: number) => ranges[i][1] },
    currentSrc: 'https://stream.example/song.mp3?vkey=private&account=secret',
    currentTime: 30, duration: 150, readyState: 4, networkState: 1,
    paused: false, seeking: false, playbackRate: 1, error: null,
}) as unknown as HTMLAudioElement;

describe('host audio health', () => {
    it('reports buffer ahead without leaking the signed URL or inventing unsupported stats', () => {
        const probe = createAudioPlaybackHealth();
        const snapshot = probe.read(media(), { state: 'running', sampleRate: 48000, baseLatency: .01 } as AudioContext);
        expect(snapshot.media?.bufferAheadSeconds).toBe(90);
        expect(snapshot.sourceHost).toBe('stream.example');
        expect(snapshot.sourceProtocol).toBe('https:');
        expect(snapshot.context).toMatchObject({ statsSupported: false, underrunEvents: null, underrunSeconds: null });
        expect(JSON.stringify(snapshot)).not.toMatch(/vkey|private|account|secret|song.mp3/);
        probe.dispose();
    });
    it('does not count a disjoint buffered range after a gap as playable', () => {
        expect(createAudioPlaybackHealth().read(media([[0, 10], [60, 120]]), null).media?.bufferAheadSeconds).toBe(0);
    });
    it('bounds event data and detaches the previous deck and cleanup listeners', () => {
        const probe = createAudioPlaybackHealth(), a = media(), b = media();
        probe.read(a, null);
        for (let i = 0; i < 50; i++) a.dispatchEvent(new Event('waiting'));
        const first = probe.read(a, null);
        expect(first.media?.events.waiting).toBe(50);
        a.dispatchEvent(new Event('playing'));
        expect(first.media?.events.playing).toBeUndefined();
        probe.read(b, null);
        a.dispatchEvent(new Event('waiting'));
        expect(probe.read(b, null).media?.events).toEqual({});
        probe.dispose();
        b.dispatchEvent(new Event('waiting'));
        expect(probe.read(null, null).media).toBeNull();
    });
    it('supports modern seconds and legacy Chromium milliseconds with real zero values', () => {
        const read = (value: object) => createAudioPlaybackHealth().read(null, value as AudioContext).context;
        expect(read({ playbackStats: { underrunEvents: 0, underrunDuration: .2, totalDuration: 5 } }))
            .toMatchObject({ statsSupported: true, underrunEvents: 0, underrunSeconds: .2, totalSeconds: 5 });
        expect(read({ playoutStats: { fallbackFramesEvents: 3, fallbackFramesDuration: 200, totalFramesDuration: 5000 } }))
            .toMatchObject({ underrunEvents: 3, underrunSeconds: .2, totalSeconds: 5 });
    });
});
