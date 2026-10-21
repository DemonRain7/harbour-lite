import React, { useMemo, useState } from 'react';
import '../../src/i18n/config';
import DesktopGrid3DSurface from '../../src/components/folia-grid/DesktopGrid3DSurface';
import { DEFAULT_THEME } from '../../src/services/baseThemes';
import { useHomeLayoutSettingsStore } from '../../src/stores/useHomeLayoutSettingsStore';
import type { ProbeDefinition } from './definition';
import '../../src/components/folia-grid/grid3DHomeLayout.css';
// dev/probes/grid3DToolbar.probe.tsx

const items = ['Evening', 'Library', '日语', 'Rain', 'Cinema'].map((name, index) => ({
    id: `probe-${index}`,
    name,
    type: 'playlist',
    description: 'Playlist',
    trackCount: 24,
    coverUrl: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="hsl(${index * 55},30%,55%)"/><stop offset="1" stop-color="#252334"/></linearGradient></defs><path fill="url(#g)" d="M0 0h400v400H0z"/><circle cx="200" cy="200" r="120" fill="none" stroke="#fff" stroke-opacity=".3" stroke-width="2"/></svg>`)}`,
}));

const Grid3DToolbarProbe: React.FC = () => {
    const [focusedIndex, setFocusedIndex] = useState(2);
    const [selected, setSelected] = useState('');
    const [floating, setFloating] = useState(true);
    const [daylight, setDaylight] = useState(false);
    const [actions, setActions] = useState(false);
    const [metadata, setMetadata] = useState(false);
    const setStyle = useHomeLayoutSettingsStore(state => state.handleSetGrid3dCardStyle);
    const collections = useMemo(() => metadata ? items.map(item => ({
        ...item, type: 'folder', name: `Library/Classical Music/Live Recordings/${item.name}`,
        summary: 'A longer album description arriving after the first render, with more than one line.',
    })) : items, [metadata]);
    return (
        <div className="h-screen flex flex-col gap-3 p-4 bg-zinc-900 text-white">
            <div className="flex shrink-0 flex-wrap gap-4 text-sm">
                <button onClick={() => setFloating(value => !value)}>Toggle player</button>
                <button onClick={() => setDaylight(value => !value)}>Toggle daylight</button>
                <button onClick={() => setActions(value => !value)}>Toggle actions</button>
                <button onClick={() => setMetadata(value => !value)}>Toggle metadata</button>
                <button onClick={() => setStyle('image')}>Image style</button>
                <button onClick={() => setStyle('card')}>Card style</button>
                <output data-testid="selected-collection">{selected}</output>
            </div>
            <div
                data-folia-home
                data-testid="embedded-folia"
                className="relative flex-1 min-h-0 flex flex-col overflow-hidden rounded-2xl"
                style={{
                    background: daylight ? '#e3dee8' : '#333139',
                    color: daylight ? '#27232e' : '#f4f0f8',
                    '--text-primary': daylight ? '#27232e' : '#f4f0f8',
                    '--text-secondary': daylight ? '#68616f' : '#bcb4c7',
                } as React.CSSProperties}
            >
                <div data-folia-home-header className="py-8 shrink-0 flex items-center justify-center">
                    <span className="h-8 flex items-center">Folia · Collections</span>
                </div>
                <div className="flex-1 min-h-0 relative">
                    <DesktopGrid3DSurface
                        title="All collections"
                        mapButtonLabel="All"
                        items={collections}
                        focusedIndex={focusedIndex}
                        onFocusedIndexChange={setFocusedIndex}
                        onSelect={item => setSelected(String(item.id))}
                        theme={DEFAULT_THEME}
                        isDaylight={daylight}
                        hasFloatingPlayer={floating}
                        actions={actions ? ['Import folder', 'Refresh library', 'Sort collections'].map(label => ({
                            id: label, label, onClick: () => setSelected(label),
                        })) : []}
                    />
                </div>
                {floating && <div data-folia-home-player-space className="flex items-center justify-center">Player reserved space</div>}
            </div>
        </div>
    );
};

const probe: ProbeDefinition = {
    id: 'grid3DToolbar',
    title: 'Grid3D · toolbar clearance',
    description: 'Collection toolbar hit testing, scaled cards and player clearance at embedded window heights.',
    Component: Grid3DToolbarProbe,
};
export default probe;
