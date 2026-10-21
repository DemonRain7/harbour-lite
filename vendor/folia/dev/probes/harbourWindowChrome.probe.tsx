import React, { useState } from 'react';
import AppShell from '../../src/components/app/AppShell';
import { useElectronWindowChrome } from '../../src/hooks/useElectronWindowChrome';
import type { ProbeDefinition } from './definition';

// dev/probes/harbourWindowChrome.probe.tsx
// The shell owns chrome only: presentation changes must preserve its child and audio instances.
function StatefulPlayer() {
    const [count, setCount] = useState(0);
    return <button type="button" className="m-16" onClick={() => setCount(value => value + 1)}>Player state: {count}</button>;
}

function HarbourWindowChromeProbe() {
    useElectronWindowChrome();
    const isElectron = Boolean(window.electron);
    return (
        <AppShell
            appStyle={{ backgroundColor: '#fafafa' }}
            isElectronWindow={isElectron}
            usesCustomWindowChrome={isElectron}
            useCustomWindowRadius={isElectron}
            showTransparentWindowBorder={isElectron}
            isPlayerView
            isTitlebarRevealed
            alwaysShowMainWindowTitlebar
            isMainWindowClickThroughEnabled={false}
            showMainWindowClickThroughToggle
            onToggleMainWindowClickThrough={() => {}}
            isDaylight
            audioElement={<audio data-probe-audio />}
        >
            <StatefulPlayer />
        </AppShell>
    );
}

export default {
    id: 'harbourWindowChrome',
    title: 'Harbour embedded window chrome',
    description: 'Native controls and drag regions follow presentation without remounting the player.',
    Component: HarbourWindowChromeProbe,
} satisfies ProbeDefinition;
