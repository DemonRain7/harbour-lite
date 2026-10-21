import { requestQqPlaybackOrigins } from './qqTransport';

const FALLBACK_HOST = 'dl.stream.qqmusic.qq.com';
const SAMPLE_BYTES = 128 * 1024;
const TIMEOUT_MS = 3500;
let directory: { origins: string[]; expires: number } | undefined;
let discovering: Promise<string[]> | undefined;

function officialOrigin(value: string): string | null {
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port
            || url.pathname !== '/' || url.search || url.hash) return null;
        if (url.hostname !== 'aqqmusic.tc.qq.com' && !url.hostname.endsWith('.stream.qqmusic.qq.com')) return null;
        return url.origin;
    } catch { return null; }
}

async function getOrigins(songmid: string) {
    if (directory && directory.expires > Date.now()) return directory.origins;
    if (!discovering) {
        discovering = requestQqPlaybackOrigins(songmid).catch(() => []).then(values => {
            const origins = [...new Set(values.map(officialOrigin).filter((s): s is string => !!s))].slice(0, 2);
            directory = { origins, expires: Date.now() + (origins.length ? 600_000 : 30_000) };
            return origins;
        }).finally(() => { discovering = undefined; });
    }
    return discovering;
}

async function probe(url: string, signal: AbortSignal): Promise<string> {
    const response = await fetch(url, {
        headers: { Range: `bytes=0-${SAMPLE_BYTES - 1}` }, credentials: 'omit',
        redirect: 'error', cache: 'no-store', signal,
    });
    const reader = response.body?.getReader();
    try {
        if (![200, 206].includes(response.status) || !reader
            || !/^(audio\/|application\/octet-stream)/i.test(response.headers.get('content-type') || '')) {
            throw new Error('UNUSABLE_MEDIA_ROUTE');
        }
        let bytes = 0;
        while (bytes < SAMPLE_BYTES) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
        }
        if (bytes < SAMPLE_BYTES) throw new Error('INSUFFICIENT_MEDIA_SAMPLE');
        return url;
    // Cancellation of a tee/cache stream can wait for its other reader. Never let
    // that cleanup promise extend playback startup; the controller is also aborted.
    } finally { void reader?.cancel().catch(() => {}); }
}

// Repair only the upstream's fallback host. An authorized link must already exist.
// Keep its exact filename/quality and signed query. Probe at most 2 directory routes,
// bound bytes/time, cancel losers; no full-song download, cookies, or URL logging.
export async function selectQqPlaybackRoute(value: string, songmid: string): Promise<string> {
    let original: URL;
    try { original = new URL(value); } catch { return value; }
    if (original.hostname !== FALLBACK_HOST || !['http:', 'https:'].includes(original.protocol)
        || original.port || original.username || original.password) return value;
    const origins = await getOrigins(songmid);
    if (!origins.length) return value;
    const suffix = original.pathname + original.search + original.hash;
    // An already-secure source must never be downgraded to the directory's legacy HTTP form.
    const candidates = [...new Set(origins.map(origin =>
        (original.protocol === 'https:' ? origin.replace(/^http:/, 'https:') : origin) + suffix))]
        .filter(url => new URL(url).hostname !== FALLBACK_HOST);
    if (!candidates.length) return value;
    // sip is the authoritative directory. Do not let the hardcoded fallback's
    // already-cached first block win a race and hide the sustained buffering fault.
    const controllers = candidates.map(() => new AbortController());
    const timer = setTimeout(() => controllers.forEach(controller => controller.abort()), TIMEOUT_MS);
    try {
        return await Promise.any(candidates.map((url, i) => probe(url, controllers[i].signal)));
    } catch { return value; }
    finally { clearTimeout(timer); controllers.forEach(controller => controller.abort()); }
}
