import type { CommandPaletteSurface } from './types';

// src/components/command-palette/surfaces/temperaWorkshopSurface.ts
// Open the same editor as the settings entry; don't switch mode, song, or playback state.
export const temperaWorkshopSurface: CommandPaletteSurface = {
    load: () => import('./TemperaWorkshopSurfaceView'),
    buildMatches: () => [],
    mapProps: ({ isDaylight, close }) => ({ isDaylight, onClosed: close }),
};
