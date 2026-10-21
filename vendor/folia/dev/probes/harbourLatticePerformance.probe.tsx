import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useMotionValue } from 'framer-motion';
import Lattice from '../../src/components/app/lattice/Lattice';
import { PlayerState, type Line, type SongResult } from '../../src/types';
import { DEFAULT_THEME } from '../../src/services/baseThemes';
import type { ProbeDefinition } from './definition';

// Synthetic covers and timed lyrics exercise the real wall without an account or network audio.
const noop = () => {};
const lines: Line[] = Array.from({ length: 80 }, (_, i) => ({
    startTime: i * 4, endTime: i * 4 + 4, fullText: '雨上がりの街を歩いて Music in the evening',
    translation: '雨后的城市，音乐仍在继续', isChorus: i % 4 === 0,
    words: ['雨上がり', 'の街を', '歩いて', 'Music ', 'in the evening'].map((text, j) => ({
        text, startTime: i * 4 + j * 0.8, endTime: i * 4 + (j + 1) * 0.8,
    })),
}));

function HarbourLatticePerformanceProbe({ queueSize = 120, bitmapCovers = false, coverBaseUrl = '' }: { queueSize?: number; bitmapCovers?: boolean; coverBaseUrl?: string }) {
    const time = useMotionValue(42);
    const [playing, setPlaying] = useState(true);
    const [visible, setVisible] = useState(true);
    const [open, setOpen] = useState(true);
    const [revision, setRevision] = useState(0);
    const covers = useMemo(() => {
        if (!bitmapCovers) return [];
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
        const ctx = canvas.getContext('2d')!;
        return Array.from({ length: 120 }, (_, i) => {
            const gradient = ctx.createLinearGradient(0, 0, 1024, 1024);
            gradient.addColorStop(0, `hsl(${i * 37 % 360} 50% 40%)`); gradient.addColorStop(1, '#17243a');
            ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1024, 1024);
            for (let j = 0; j < 200; j++) {
                ctx.fillStyle = `hsla(${(i + j) * 19 % 360} 50% 70% / .3)`;
                ctx.fillRect((j * 137) % 1024, (j * 251) % 1024, 90, 45);
            }
            ctx.fillStyle = 'white'; ctx.font = '80px sans-serif'; ctx.fillText(`Cover ${i}`, 70, 800);
            return canvas.toDataURL('image/jpeg', .9);
        });
    }, [bitmapCovers]);
    const queue = useMemo<SongResult[]>(() => Array.from({ length: queueSize }, (_, i) => ({
        id: String(i), name: `Music in the evening · 雨后的城市 ${i}`, artists: [{ id: 1, name: 'Fixture artist' }],
        album: { id: i, name: 'Album', coverUrl: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><defs><linearGradient id="a"><stop stop-color="hsl(${i * 37 % 360},50%,40%)"/><stop offset="1" stop-color="#17243a"/></linearGradient></defs><path fill="url(#a)" d="M0 0h512v512H0z"/><circle cx="190" cy="170" r="130" fill="#dca" opacity=".3"/><text x="40" y="420" fill="white" font-size="64">${i}</text></svg>`)}` },
        durationMs: 320000, sourceRef: { kind: 'online' as const, providerId: 'netease' as const, mediaId: String(i) },
    })).map((song, i) => coverBaseUrl ? { ...song, sourceRef: { kind: 'navidrome' as const, mediaId: String(i) },
        album: { ...song.album, coverUrl: `${coverBaseUrl}/getCoverArt?cover=${i % 120}` } }
        : covers.length ? { ...song, album: { ...song.album, coverUrl: covers[i % covers.length] } } : song), [queueSize, covers, coverBaseUrl]);
    useEffect(() => {
        if (!playing) return;
        let frame: number;
        const start = performance.now(), from = time.get();
        const tick = () => { time.set((from + (performance.now() - start) / 1000) % 300); frame = requestAnimationFrame(tick); };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [playing, time]);
    return <div style={{ height: '100vh' }} data-revision={revision}>
        <div style={{ display: visible ? 'block' : 'none' }}>
            <AnimatePresence>
            {open && <motion.div key="wall" exit={{ opacity: 0 }} transition={{ duration: .62 }}>
            <Lattice controls={{ loopMode: 'all', playback: {
                prev: noop, next: noop, toggleLoop: noop, shuffleQueue: noop,
                toggleSongLike: noop, isSongLiked: false, isFmMode: false,
            }, invokeCommandById: noop, canInvokeCommandById: () => true }}
                lyrics={{ lines }} lyricSource={{ lines, currentTime: time, currentLineIndex: 10,
                    theme: DEFAULT_THEME, paused: !playing, staticMode: false, showSubtitleTranslation: true }}
                lyricKeywordColoringEnabled queue={queue} currentSong={queue[13 % queueSize]}
                playerState={playing ? PlayerState.PLAYING : PlayerState.PAUSED}
                currentTime={time} playbackDuration={320} canTogglePlayback isDaylight={false}
                onBack={noop} onOpenPlayer={noop} onPlaySong={noop}
                onTogglePlayback={() => setPlaying(value => !value)} onSeek={value => time.set(value)} />
            </motion.div>}
            </AnimatePresence>
        </div>
        <div style={{ position: 'fixed', top: 0, right: 0, zIndex: 100 }}>
            <button onClick={() => setPlaying(value => !value)}>Toggle clock</button>
            <button onClick={() => setRevision(value => value + 1)}>Rerender parent</button>
            <button onClick={() => setVisible(value => !value)}>Toggle visibility</button>
            <button onClick={() => setOpen(value => !value)}>Toggle wall</button>
        </div>
    </div>;
}

export default {
    id: 'harbourLatticePerformance', title: 'Harbour lattice performance',
    description: '120/1200-song wall, timed lyrics, culling, playback and parent-render isolation.',
    Component: HarbourLatticePerformanceProbe,
} satisfies ProbeDefinition;
