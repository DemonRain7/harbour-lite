import { useEffect, useMemo, type CSSProperties, type ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MotionValue } from 'framer-motion';
import { PlayerState, type SongResult, type LyricData } from '../../../types';
import LatticePlaybackProvider, { type LatticePlaybackActions } from './LatticePlaybackProvider';
import { LatticeTransportContext, type LatticeTransport } from './LatticeTransportContext';
import PosterWall from './PosterWall';
import LatticeFocusButton from './LatticeFocusButton';
import { buildLatticeTiles, type LatticeTile } from './latticeModel';
import { useStableCallbacks } from '../../../hooks/useStableCallbacks';
import { useLatticeSettingsStore } from '../../../stores/useLatticeSettingsStore';
import { countRender } from '../../../dev/renderCount';
import './Lattice.css';
import LatticeLyricsProvider from './lyrics/LatticeLyricsProvider';
import type { LatticeLyricSource } from './lyrics/types';
import { getPlaybackSongKey } from '../../../utils/appPlaybackGuards';
import { useLatticeToggleHotkey } from './useLatticeToggleHotkey';
import { useLatticeControlsStore } from '../../../stores/useLatticeControlsStore';

// Queue display layer; it renders the play queue and never mutates it.

export type LatticeProps = {
    controls: LatticePlaybackActions;
    lyrics: LyricData | null;
    lyricSource: LatticeLyricSource;
    lyricKeywordColoringEnabled: boolean;
    currentSong: SongResult | null;
    playerState: PlayerState;
    currentTime: MotionValue<number>;
    playbackDuration: number;
    canTogglePlayback: boolean;
    queue: SongResult[];
    /** Browsing a playlist must not replace the transport's actual playback queue. */
    playbackQueue?: SongResult[];
    isDaylight: boolean;
    onBack: () => void;
    onOpenPlayer: () => void;
    onPlaySong: (song: SongResult, queue: SongResult[]) => void;
    onPlayNext?: (song: SongResult) => void;
    canPlayNext?: boolean;
    onTogglePlayback: () => void;
    onSeek: (time: number) => void;
    onToggleView?: () => void;
    children?: ReactNode;
    emptyTitle?: string;
    emptyText?: string;
};

export default function Lattice({
    controls,
    lyrics,
    lyricSource,
    lyricKeywordColoringEnabled,
    currentSong,
    playerState,
    currentTime,
    playbackDuration,
    canTogglePlayback,
    queue,
    playbackQueue = queue,
    isDaylight,
    onBack,
    onOpenPlayer,
    onPlaySong,
    onPlayNext,
    canPlayNext = false,
    onTogglePlayback,
    onSeek,
    onToggleView = onBack,
    children,
    emptyTitle,
    emptyText,
}: LatticeProps) {
    countRender('Lattice');
    // A playlist collage still belongs to Home navigation, but its opaque wall must suspend
    // the full-screen lyric/background renderer underneath it too. Cleanup survives StrictMode.
    useEffect(() => useLatticeControlsStore.getState().registerWall(), []);
    const { t } = useTranslation();
    const vignette = useLatticeSettingsStore(state => state.latticeVignette);
    const lightsOn = useLatticeSettingsStore(state => state.latticeLightsOn);
    const posterTintEnabled = useLatticeSettingsStore(state => state.latticePosterTintEnabled);
    const posterTintUseCustomColor = useLatticeSettingsStore(state => state.latticePosterTintUseCustomColor);
    const posterTintColor = useLatticeSettingsStore(state => state.latticePosterTintColor);
    const posterTintIntensity = useLatticeSettingsStore(state => state.latticePosterTintIntensity);
    const tiles = useMemo(() => buildLatticeTiles({ queue, currentSong }), [currentSong, queue]);

    useLatticeToggleHotkey(true, onToggleView);

    // App rebuilds these on every render of its own, and the wall hands them to every poster on
    // screen. Given a permanent identity here they stop being a reason for those posters to render.
    const wall = useStableCallbacks({
        onPlay: (tile: LatticeTile) => onPlaySong(tile.song, queue),
        onPlayNext: (tile: LatticeTile) => onPlayNext?.(tile.song),
        onTogglePlayback,
        onSeek,
        onOpenPlayer,
    });

    // Recomputed only when transport state actually moves, so the expanded chrome is the only
    // subscriber that re-renders on a pause, a resume or a duration update.
    const transport = useMemo<LatticeTransport>(
        () => ({ currentSong, playerState, currentTime, playbackDuration, canTogglePlayback, canPlayNext }),
        [canTogglePlayback, canPlayNext, currentSong, currentTime, playbackDuration, playerState],
    );

    return (
        <LatticeTransportContext.Provider value={transport}>
        <LatticePlaybackProvider actions={controls} currentSong={currentSong} queue={playbackQueue} lyrics={lyrics}
            currentTime={currentTime} duration={playbackDuration} onSeek={onSeek} isDaylight={isDaylight}>
        <LatticeLyricsProvider source={lyricSource} songKey={currentSong ? getPlaybackSongKey(currentSong) : ''}
            keywordColoringEnabled={lyricKeywordColoringEnabled}>
        <section
            className={`lattice-root ${isDaylight ? 'is-daylight' : ''} ${vignette ? 'has-vignette' : ''} ${lightsOn ? '' : 'is-lights-out'} ${posterTintEnabled ? 'has-poster-tint' : ''} ${posterTintUseCustomColor ? 'uses-custom-poster-tint' : ''}`}
            style={{
                '--lattice-poster-tint-color': posterTintColor,
                '--lattice-poster-tint-intensity': posterTintIntensity,
            } as CSSProperties}
            aria-label={t('home.latticeLabel')}
        >
            <PosterWall
                tiles={tiles}
                currentSong={currentSong}
                onPlay={wall.onPlay}
                onPlayNext={wall.onPlayNext}
                onTogglePlayback={wall.onTogglePlayback}
                onSeek={wall.onSeek}
                onOpenPlayer={wall.onOpenPlayer}
                onBack={onBack}
            />
            <LatticeFocusButton isDaylight={isDaylight} />
            <button type="button" className="lattice-back" onClick={onBack}
                aria-label={t('home.latticeBack')} title={t('home.latticeBack')}>
                <ChevronLeft size={20} />
            </button>
            {tiles.length === 0 && (
                <div className="lattice-empty">
                    <strong>{emptyTitle ?? t('home.latticeEmptyTitle')}</strong>
                    <span>{emptyText ?? t('home.latticeEmptyText')}</span>
                </div>
            )}
            {children}
        </section>
        </LatticeLyricsProvider>
        </LatticePlaybackProvider>
        </LatticeTransportContext.Provider>
    );
}
