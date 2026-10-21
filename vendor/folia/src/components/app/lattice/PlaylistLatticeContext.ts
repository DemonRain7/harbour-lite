import { createContext } from 'react';
import type { LatticeProps } from './Lattice';

// src/components/app/lattice/PlaylistLatticeContext.ts
// Share existing playback/lyrics actions with playlist presentation, without another player.
export type PlaylistLatticeModel = Omit<LatticeProps, 'onBack' | 'onToggleView' | 'children'>;
export const PlaylistLatticeContext = createContext<PlaylistLatticeModel | null>(null);
// GridView only needs to know whether this presentation exists. Playback and
// lyric updates belong to the mounted collage, not its whole library/loader.
export const PlaylistLatticeAvailableContext = createContext(false);
