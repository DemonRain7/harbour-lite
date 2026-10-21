import React from 'react';
import TemperaImageLayerControls from '../../visualizer/tempera/TemperaImageLayerControls';
import { useVisualizerSettingsStore } from '../../../stores/useVisualizerSettingsStore';

// src/components/command-palette/surfaces/TemperaWorkshopSurfaceView.tsx
export default function TemperaWorkshopSurfaceView({ isDaylight, onClosed }: {
    isDaylight: boolean; onClosed: () => void;
}) {
    const tuning = useVisualizerSettingsStore(state => state.temperaTuning);
    const commit = useVisualizerSettingsStore(state => state.handleSetTemperaTuning);
    return <TemperaImageLayerControls initiallyOpen onClosed={onClosed}
        images={tuning.layerImages} depth={tuning.layerImageDepth} frequency={tuning.layerImageFrequency}
        isDaylight={isDaylight} rangeInputClass="w-full accent-current" onCommit={commit} />;
}
