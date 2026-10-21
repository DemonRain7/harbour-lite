import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const discover = vi.hoisted(() => vi.fn());
vi.mock('@/services/onlineMusic/qqTransport', () => ({ requestQqPlaybackOrigins: discover }));
const original = 'http://dl.stream.qqmusic.qq.com/M800song.mp3?vkey=secret%2Fencoded&guid=42';
const cdn = 'http://aqqmusic.tc.qq.com';
const audio = () => new Response(new Uint8Array(128 * 1024), {
    status: 206, headers: { 'Content-Type': 'audio/mpeg' },
});
const pending = (_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
});

describe('QQ authorized playback route selection', () => {
    beforeEach(() => {
        vi.resetModules(); discover.mockReset(); discover.mockResolvedValue([`${cdn}/`, 'http://sjy6.stream.qqmusic.qq.com/']);
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

    it('selects the responsive official route, preserves authorization/quality, and aborts losers', async () => {
        const fetcher = vi.fn((url: string, options: RequestInit) => url.startsWith(cdn)
            ? Promise.resolve(audio()) : pending(url, options));
        vi.stubGlobal('fetch', fetcher);
        const { selectQqPlaybackRoute } = await import('@/services/onlineMusic/qqPlaybackRoute');
        expect(await selectQqPlaybackRoute(original, 'song')).toBe(original.replace('http://dl.stream.qqmusic.qq.com', cdn));
        for (const [url, options] of fetcher.mock.calls) {
            expect(new URL(url).search).toBe(new URL(original).search);
            expect(new URL(url).pathname).toBe('/M800song.mp3');
            expect(options).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store', headers: { Range: 'bytes=0-131071' } });
            expect(options.signal!.aborted).toBe(true);
            expect(new URL(url).hostname).not.toBe('dl.stream.qqmusic.qq.com');
        }
    });

    it('fails back to the original link on denied, non-audio or truncated responses', async () => {
        for (const response of [new Response('', { status: 403 }), Response.json({ error: 'denied' }),
            new Response('short', { headers: { 'Content-Type': 'audio/mpeg' } })]) {
            vi.resetModules();
            vi.stubGlobal('fetch', vi.fn(async () => response.clone()));
            const { selectQqPlaybackRoute } = await import('@/services/onlineMusic/qqPlaybackRoute');
            expect(await selectQqPlaybackRoute(original, 'song')).toBe(original);
        }
    });

    it('bounds stalled probes and cancels every outstanding request', async () => {
        vi.useFakeTimers(); const fetcher = vi.fn(pending); vi.stubGlobal('fetch', fetcher);
        const { selectQqPlaybackRoute } = await import('@/services/onlineMusic/qqPlaybackRoute');
        const result = selectQqPlaybackRoute(original, 'song');
        await vi.advanceTimersByTimeAsync(3500);
        expect(await result).toBe(original);
        expect(fetcher.mock.calls.every(([, options]) => options.signal!.aborted)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not probe arbitrary hosts or forward signed links to untrusted origins', async () => {
        discover.mockResolvedValue(['http://127.0.0.1/', 'https://evil.test/', 'https://aqqmusic.tc.qq.com.evil.test/',
            'https://user@aqqmusic.tc.qq.com/', 'https://aqqmusic.tc.qq.com/path', 'https://aqqmusic.tc.qq.com:99/']);
        const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
        const { selectQqPlaybackRoute } = await import('@/services/onlineMusic/qqPlaybackRoute');
        expect(await selectQqPlaybackRoute('https://other.example/song.mp3', 'song')).toBe('https://other.example/song.mp3');
        expect(discover).not.toHaveBeenCalled();
        expect(await selectQqPlaybackRoute(original, 'song')).toBe(original);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('shares only the origin directory across concurrent songs, never a signed song URL', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => audio()));
        const { selectQqPlaybackRoute } = await import('@/services/onlineMusic/qqPlaybackRoute');
        const other = original.replace('M800song', 'F000second').replace('guid=42', 'guid=99');
        const results = await Promise.all([selectQqPlaybackRoute(original, 'song'), selectQqPlaybackRoute(other, 'second')]);
        expect(discover).toHaveBeenCalledTimes(1);
        expect(results[0]).toContain('M800song.mp3'); expect(results[1]).toContain('F000second.mp3');
        expect(results[1]).toContain('guid=99');
    });

    it('tolerates unavailable discovery and does not invent CDN/media links', async () => {
        discover.mockRejectedValue(new Error('offline')); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
        const { selectQqPlaybackRoute } = await import('@/services/onlineMusic/qqPlaybackRoute');
        expect(await selectQqPlaybackRoute(original, 'song')).toBe(original);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('cancels ignored-Range streams after the sample instead of downloading the whole song', async () => {
        const cancelled = vi.fn(); let reads = 0;
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
            pull(controller) { reads++; controller.enqueue(new Uint8Array(64 * 1024)); },
            cancel: cancelled,
        }), { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })));
        const { selectQqPlaybackRoute } = await import('@/services/onlineMusic/qqPlaybackRoute');
        await selectQqPlaybackRoute(original, 'song');
        expect(cancelled).toHaveBeenCalledTimes(2);
        expect(reads).toBeLessThanOrEqual(6); // two samples plus at most one queued chunk per stream
    });

    it('never downgrades an already-HTTPS source and handles explicit default ports', async () => {
        const fetcher = vi.fn(async (_url: string) => audio()); vi.stubGlobal('fetch', fetcher);
        const { selectQqPlaybackRoute } = await import('@/services/onlineMusic/qqPlaybackRoute');
        const secure = original.replace('http:', 'https:').replace('qq.com/', 'qq.com:443/');
        const result = await selectQqPlaybackRoute(secure, 'song');
        expect(result.startsWith('https:')).toBe(true);
        expect(new URL(result).pathname).toBe('/M800song.mp3');
        expect(new URL(result).search).toBe(new URL(original).search);
        expect(fetcher.mock.calls.every(call => String(call[0]).startsWith('https:'))).toBe(true);
    });
});
