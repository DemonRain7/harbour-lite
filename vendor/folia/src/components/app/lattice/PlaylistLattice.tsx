import { ListMusic, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useContext } from 'react';
import type { SongResult } from '../../../types';
import { isSongUnavailable } from '../../../services/onlineMusic/songAvailability';
import Lattice from './Lattice';
import { PlaylistLatticeContext } from './PlaylistLatticeContext';

// src/components/app/lattice/PlaylistLattice.tsx
// Presentation only: GridView retains its shared loader, paging, cache and management actions.
export default function PlaylistLattice({ tracks, title, loading, failed, errorMessage, onBack, onManage, onRetry }: {
    tracks: SongResult[];
    title: string;
    loading: boolean;
    failed: boolean;
    /** Already translated by the shared loader; this presentation never classifies provider errors. */
    errorMessage?: string;
    onBack: () => void;
    onManage: () => void;
    onRetry: () => void;
}) {
    const { t } = useTranslation();
    const model = useContext(PlaylistLatticeContext);
    if (!model) return null;
    return <Lattice {...model} queue={tracks} playbackQueue={model.queue} onBack={onBack}
        onToggleView={onManage}
        onPlaySong={(song, songs) => {
            if (!isSongUnavailable(song)) model.onPlaySong(song, songs.filter(track => !isSongUnavailable(track)));
        }}
        emptyTitle={loading ? t('home.playlistCollageLoading') : failed ? t('home.playlistCollageFailed') : t('home.playlistCollageEmpty')}
        emptyText={loading ? title : errorMessage ?? t('home.playlistCollageEmptyHint')}>
        <header className="playlist-lattice-heading">
            <div><strong>{title}</strong><small>{t('home.playlistCollageCount', { count: tracks.length })}</small></div>
            {loading && <Loader2 className="animate-spin" size={18} aria-label={t('home.playlistCollageLoading')} />}
            {failed && <button type="button" onClick={onRetry} aria-label={t('ui.retry')}><RefreshCw size={18} /></button>}
            <button type="button" onClick={onManage}><ListMusic size={18} />{t('home.playlistCollageManage')}</button>
        </header>
    </Lattice>;
}
