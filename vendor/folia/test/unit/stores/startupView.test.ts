import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readStartupView, STARTUP_VIEW_STORAGE_KEY } from '../../../src/services/startupView';

// test/unit/stores/startupView.test.ts
// Launch navigation is independent of listening state and survives a fresh settings store.
vi.mock('../../../src/i18n/config', () => ({ default: { t: (key: string) => key } }));

let values: Map<string, string>;
beforeEach(() => {
    vi.resetModules();
    values = new Map();
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
    });
});
afterEach(() => vi.unstubAllGlobals());

describe('launch view preference', () => {
    it.each([undefined, 'true', 'false'])('starts in the library with old flag %s', legacy => {
        if (legacy !== undefined) values.set('open_player_on_launch', legacy);
        expect(readStartupView()).toBe('home');
    });

    it.each(['home', 'player', 'lattice'] as const)('respects a saved %s launch preference', async view => {
        values.set(STARTUP_VIEW_STORAGE_KEY, view);
        expect(readStartupView()).toBe(view);
        const { useAppViewStore } = await import('../../../src/stores/useAppViewStore');
        const { useDesktopSettingsStore } = await import('../../../src/stores/useDesktopSettingsStore');
        expect(useAppViewStore.getState().view).toBe(view);
        expect(useDesktopSettingsStore.getState().startupView).toBe(view);
    });

    it('falls back for an invalid value and without a browser', () => {
        values.set(STARTUP_VIEW_STORAGE_KEY, 'unknown');
        expect(readStartupView()).toBe('home');
        vi.stubGlobal('window', undefined);
        expect(readStartupView()).toBe('home');
    });

    it('persists only the launch preference, not current navigation or playback', async () => {
        values.set('folia_auto_play_on_launch', 'false');
        values.set('player_volume', '0.42');
        const { useDesktopSettingsStore } = await import('../../../src/stores/useDesktopSettingsStore');
        const { useAppViewStore } = await import('../../../src/stores/useAppViewStore');
        useDesktopSettingsStore.getState().handleSetStartupView('lattice');
        expect(useAppViewStore.getState().view).toBe('home');
        useDesktopSettingsStore.getState().handleSetStartupView('invalid' as never);
        expect(useDesktopSettingsStore.getState().startupView).toBe('lattice');
        expect(Object.fromEntries(values)).toEqual({
            folia_auto_play_on_launch: 'false', player_volume: '0.42', folia_startup_view: 'lattice',
        });
        vi.resetModules();
        const fresh = await import('../../../src/stores/useDesktopSettingsStore');
        expect(fresh.useDesktopSettingsStore.getState().startupView).toBe('lattice');
    });
});
