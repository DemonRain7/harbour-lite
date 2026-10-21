import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import VisualizerRenderer from '@/components/visualizer/VisualizerRenderer';
import { isHarbourVisualActive } from '@/hooks/useHarbourVisualActivity';

// test/unit/visualizer/harbourVisibility.test.ts
const state = vi.hoisted(() => ({ presentation: null as 'embedded' | 'window' | 'background' | null }));
vi.mock('@/hooks/useHarbourFoliaPresentation', () => ({ useHarbourFoliaPresentation: () => state.presentation }));
vi.mock('@/components/visualizer/registry', () => ({
    getVisualizerRegistryEntry: () => ({ render: () => React.createElement('canvas', { 'data-heavy-visual': true }) }),
}));
vi.mock('@/components/visualizer/tuningRegistry', () => ({ applyVisualizerTuning: (_mode: unknown, props: unknown) => props }));
vi.mock('@/components/visualizer/backgrounds/registry', () => ({ DEFAULT_VISUALIZER_BACKGROUND_MODE: 'common' }));
vi.mock('@/components/visualizer/VisualizerHarmonyOverlay', () => ({ default: () => React.createElement('i', null, 'lyric') }));

describe('Harbour visual activity', () => {
    it('uses host visibility for reparented views and browser visibility for standalone web', () => {
        expect(isHarbourVisualActive('embedded', true)).toBe(true);
        expect(isHarbourVisualActive('window', false)).toBe(true);
        expect(isHarbourVisualActive('background', false)).toBe(false);
        expect(isHarbourVisualActive(null, true)).toBe(false);
        expect(isHarbourVisualActive(null, false)).toBe(true);
    });
    it('unmounts only the visualizer subtree in background and mounts current props on return', () => {
        const props = { mode: 'still', lines: [], theme: {} } as unknown as React.ComponentProps<typeof VisualizerRenderer>;
        state.presentation = 'window';
        expect(renderToStaticMarkup(React.createElement(VisualizerRenderer, props))).toContain('data-heavy-visual');
        state.presentation = 'background';
        expect(renderToStaticMarkup(React.createElement(VisualizerRenderer, props))).toBe('');
        state.presentation = 'embedded';
        expect(renderToStaticMarkup(React.createElement(VisualizerRenderer, props))).toContain('lyric');
        state.presentation = null;
    });
});
