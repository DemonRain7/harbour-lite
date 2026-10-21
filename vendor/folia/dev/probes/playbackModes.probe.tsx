import React, { useState } from 'react';
import { motionValue } from 'framer-motion';
import FloatingPlayerControls from '../../src/components/FloatingPlayerControls';
import SongActionRow from '../../src/components/panelTab/controls/SongActionRow';
import { PlayerState } from '../../src/types';
import { useAudioSettingsStore } from '../../src/stores/useAudioSettingsStore';
import { buildThemeSourceModel } from '../../src/hooks/themeControllerState';
import { DEFAULT_THEME } from '../../src/services/baseThemes';
import type { ProbeDefinition } from './definition';

// Real native controls share the production audio settings store; no audio, accounts or host windows.
const currentTime = motionValue(0);
const themeSourceModel = buildThemeSourceModel({
    bgMode: 'default', aiTheme: null, legacyTheme: null, customTheme: null, isDaylight: false,
    defaultTheme: DEFAULT_THEME, daylightTheme: DEFAULT_THEME, currentSongHasLocalAiTheme: false,
});

const PlaybackModesProbe: React.FC = () => {
    const loopMode = useAudioSettingsStore(state => state.loopMode);
    const toggleMode = useAudioSettingsStore(state => state.handleToggleLoopMode);
    const [shuffleHits, setShuffleHits] = useState(0);
    return (
        <div className="h-screen bg-zinc-900 text-white p-12" data-playback-mode={loopMode} data-shuffle-hits={shuffleHits}>
            <section data-testid="mode-panel" className="max-w-md">
                <SongActionRow loopMode={loopMode} onToggleLoop={toggleMode} loopToggleDisabled={false}
                    onLike={() => {}} isLiked={false} likeDisabled={true} onGenerateAITheme={() => {}}
                    isGeneratingTheme={false} canGenerateAITheme={false} themeSourceModel={themeSourceModel} isDaylight={false} />
            </section>
            <section data-testid="mode-player">
                <FloatingPlayerControls currentSong={{ name: 'Mode test' }} playerState={PlayerState.PAUSED}
                    currentTime={currentTime} duration={200} loopMode={loopMode} currentView="player"
                    audioSrc="probe://not-played" canTogglePlay lyrics={null} onSeek={() => {}}
                    onTogglePlay={() => {}} onToggleLoop={toggleMode} onNavigateToPlayer={() => {}} isDaylight={false}
                    onCommitBottomBarOffset={() => {}}
                    slotPrimary="loop" slotSecondary="shuffle" slotContext={{
                        onShuffle: () => setShuffleHits(hits => hits + 1), canShuffle: true,
                        onLike: () => {}, isLiked: false, likeDisabled: true,
                        invokeCommandById: () => {}, canInvokeCommandById: () => true,
                    }} />
            </section>
        </div>
    );
};

const definition: ProbeDefinition = {
    id: 'playbackModes', title: '播放模式同步', description: '原生胶囊和控制面板共享四态，并区分打乱队列。',
    Component: PlaybackModesProbe,
};
export default definition;
