// Read-only, bounded diagnostics on the host's existing one-second status tick.
// No audio capture, signed URLs, device IDs, new timer, or React state updates.
const EVENTS = ['waiting', 'stalled', 'playing', 'pause', 'emptied', 'error'] as const;
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
type Stats = Partial<Record<'underrunEvents' | 'underrunDuration' | 'totalDuration'
    | 'fallbackFramesEvents' | 'fallbackFramesDuration' | 'totalFramesDuration', number>>;
type MeasurableContext = AudioContext & { playbackStats?: Stats; playoutStats?: Stats };

export function createAudioPlaybackHealth() {
    let observed: HTMLAudioElement | null = null;
    let counts: Record<string, number> = {};
    let lastEvent: { type: string; at: number } | null = null;
    const onEvent = (event: Event) => {
        counts[event.type] = (counts[event.type] || 0) + 1;
        lastEvent = { type: event.type, at: Date.now() };
    };
    const detach = () => {
        if (observed) EVENTS.forEach(type => observed!.removeEventListener(type, onEvent));
        observed = null;
    };
    return {
        read(audio: HTMLAudioElement | null, context: AudioContext | null) {
            if (audio !== observed) {
                detach(); observed = audio; counts = {}; lastEvent = null;
                if (audio) EVENTS.forEach(type => audio.addEventListener(type, onEvent));
            }
            let bufferAheadSeconds = 0;
            if (audio) {
                // A disjoint seek range must not be mistaken for playable buffered audio.
                for (let i = 0; i < audio.buffered.length; i++) {
                    if (audio.buffered.start(i) <= audio.currentTime && audio.currentTime <= audio.buffered.end(i)) {
                        bufferAheadSeconds = Math.max(0, audio.buffered.end(i) - audio.currentTime);
                        break;
                    }
                }
            }
            let sourceHost: string | null = null;
            let sourceProtocol: string | null = null;
            try {
                const source = audio?.currentSrc ? new URL(audio.currentSrc) : null;
                sourceHost = source?.hostname || null;
                sourceProtocol = source?.protocol || null;
            } catch { /* no source */ }
            const ctx = context as MeasurableContext | null;
            const stats = ctx?.playbackStats;
            const legacy = ctx?.playoutStats;
            const legacySeconds = (value: unknown) => finite(value) === null ? null : (value as number) / 1000;
            return {
                sampledAt: Date.now(), sourceHost, sourceProtocol,
                media: audio ? {
                    readyState: audio.readyState, networkState: audio.networkState,
                    paused: audio.paused, seeking: audio.seeking, playbackRate: audio.playbackRate,
                    currentTime: finite(audio.currentTime), duration: finite(audio.duration),
                    bufferAheadSeconds, errorCode: audio.error?.code || null,
                    events: { ...counts }, lastEvent: lastEvent ? { ...lastEvent } : null,
                } : null,
                context: ctx ? {
                    state: ctx.state, sampleRate: ctx.sampleRate,
                    baseLatencySeconds: finite(ctx.baseLatency), outputLatencySeconds: finite(ctx.outputLatency),
                    statsSupported: !!(stats || legacy),
                    underrunEvents: finite(stats?.underrunEvents ?? legacy?.fallbackFramesEvents),
                    underrunSeconds: stats ? finite(stats.underrunDuration) : legacySeconds(legacy?.fallbackFramesDuration),
                    totalSeconds: stats ? finite(stats.totalDuration) : legacySeconds(legacy?.totalFramesDuration),
                } : null,
            };
        },
        dispose: detach,
    };
}
