import { getStoredString } from '../stores/storagePrimitives';

// src/services/startupView.ts
// One launch preference for the initial view and settings; unrelated to playback/autoplay.
export type StartupView = 'home' | 'player' | 'lattice';
export const STARTUP_VIEW_STORAGE_KEY = 'folia_startup_view';

export const isStartupView = (value: unknown): value is StartupView => (
    value === 'home' || value === 'player' || value === 'lattice'
);

export const readStartupView = (): StartupView => {
    const saved = getStoredString(STARTUP_VIEW_STORAGE_KEY, 'home');
    // The old two-way open_player_on_launch flag is superseded by this explicit choice.
    // Browse the library first. Playlist presentation is separate from the launch preference.
    return isStartupView(saved) ? saved : 'home';
};
