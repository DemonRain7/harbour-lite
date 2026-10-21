import React from 'react';
import UnifiedPanel from '../UnifiedPanel';
import type { PlayerPanelViewModel } from './player-panel/buildPlayerPanelModel';
import { countRender } from '../../dev/renderCount';
import PlayerEmptyState from './player-panel/PlayerEmptyState';

// App-level entry for the player side panel backed by a view model.
type PlayerPanelProps = {
    model: PlayerPanelViewModel;
};

const PlayerPanel: React.FC<PlayerPanelProps> = ({ model }) => {
    countRender('PlayerPanel');
    const { playback, account } = model.panelProps;
    return <>
        {!playback.currentSong && !playback.isStageContext && !playback.isOpen && (
            <PlayerEmptyState theme={playback.theme} isDaylight={account.isDaylight} onBack={playback.onNavigateHomeDirect} />
        )}
        <UnifiedPanel {...model.panelProps} />
    </>;
};

// Memoised: see the note in Home.tsx. `playerPanelModel` is the only prop, so this holds exactly
// as long as that memo does.
export default React.memo(PlayerPanel);
