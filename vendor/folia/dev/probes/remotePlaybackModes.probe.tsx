import React, { useEffect, useState } from 'react';
import RemoteControlApp from '../../src/components/remote/RemoteControlApp';
import { useAudioSettingsStore } from '../../src/stores/useAudioSettingsStore';
import { PlayerState } from '../../src/types';
import { idleVideoExportState } from '../../src/types/videoExport';
import type { RemoteControlCommand, RemoteControlSnapshot } from '../../src/types/remoteControl';
import type { ProbeDefinition } from './definition';

// A browser-only IPC seam drives the real Remote UI from the real mode store, never a desktop window.
const snapshot = (): RemoteControlSnapshot => ({
    hasTrack: true, trackKey: 'probe:track', title: 'Mode test', artist: 'Probe', coverUrl: null,
    currentTime: 0, duration: 200, playerState: PlayerState.PAUSED,
    loopMode: useAudioSettingsStore.getState().loopMode, canToggleLoop: true,
    canGoPrevious: false, canGoNext: false, prevTrackKey: null, prevTrackTitle: null,
    prevTrackArtist: null, prevTrackCoverUrl: null, nextTrackKey: null, nextTrackTitle: null,
    nextTrackArtist: null, nextTrackCoverUrl: null, trackTransition: null, controlsDisabled: false,
    isStageActive: false, transparentModeEnabled: false, mainWindowClickThroughEnabled: false,
    mainWindowAlwaysOnTop: false, mainWindowBorderVisible: false, playerChromeHidden: false,
    playerChromeVisibilityMode: 'always-visible', exportState: idleVideoExportState(), isDaylight: false,
    lyrics: null, isLiked: false, canLike: false, updatedAt: 0,
});

const RemotePlaybackModesProbe: React.FC = () => {
    const [ready, setReady] = useState(false);
    useEffect(() => {
        const previous = window.electron;
        window.electron = {
            getRemoteControlSnapshot: async () => snapshot(),
            onRemoteControlSnapshot: (listener: (value: RemoteControlSnapshot) => void) => useAudioSettingsStore.subscribe(() => listener(snapshot())),
            sendRemoteControlCommand: async (command: RemoteControlCommand) => {
                if (command.type === 'cycle-loop-mode') useAudioSettingsStore.getState().handleToggleLoopMode();
            },
        } as unknown as typeof window.electron;
        setReady(true);
        return () => { window.electron = previous; };
    }, []);
    return ready ? <RemoteControlApp /> : null;
};

const definition: ProbeDefinition = {
    id: 'remotePlaybackModes', title: 'Remote 播放模式', description: 'Remote 回执和命令调用共享四态播放模式。',
    Component: RemotePlaybackModesProbe,
};
export default definition;
