import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StateCreator } from 'zustand/vanilla';
import type { CommandPaletteContext } from '@/components/command-palette/types';
import type { CommandPaletteContextDeps } from '@/hooks/useCommandPaletteContext';

// test/unit/command-palette/playbackEntryViewContext.test.ts
// Use the existing node-only hook-test pattern, preserving memo dependencies and real Zustand
// subscriptions so neither a missing subscription nor a missing memo dependency can pass.
const runtime = vi.hoisted(() => ({
    slots: [] as Array<{ current?: unknown; deps?: readonly unknown[]; snapshot?: unknown;
        getSnapshot?: () => unknown; unsubscribe?: () => void }>,
    cursor: 0,
    dirty: false,
    t: (key: string, fallback?: string) => fallback ?? key,
}));

vi.mock('react', async importOriginal => {
    const actual = await importOriginal<typeof import('react')>();
    const useMemo = (factory: () => unknown, deps: readonly unknown[]) => {
        const index = runtime.cursor++;
        const slot = runtime.slots[index] ??= {};
        if (!slot.deps || deps.length !== slot.deps.length || deps.some((value, i) => !Object.is(value, slot.deps![i]))) {
            slot.current = factory();
            slot.deps = deps;
        }
        return slot.current;
    };
    const hooks = {
        useMemo,
        useCallback: (callback: unknown, deps: readonly unknown[]) => useMemo(() => callback, deps),
        useRef: (initial: unknown) => {
            const index = runtime.cursor++;
            return runtime.slots[index] ??= { current: initial };
        },
        useDebugValue: () => undefined,
        useSyncExternalStore: (subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown) => {
            const index = runtime.cursor++;
            const slot = runtime.slots[index] ??= {};
            slot.getSnapshot = getSnapshot;
            slot.snapshot = getSnapshot();
            slot.unsubscribe ??= subscribe(() => {
                if (!Object.is(slot.snapshot, slot.getSnapshot!())) runtime.dirty = true;
            });
            return slot.snapshot;
        },
    };
    return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock('react-i18next', async importOriginal => ({
    ...await importOriginal<typeof import('react-i18next')>(),
    useTranslation: () => ({ t: runtime.t }),
}));
// External node_modules do not consume Vitest's React mock. Keep Zustand's real vanilla store
// and route only its React binding through the same hook runtime as the application hook.
vi.mock('zustand', async () => {
    const { createStore } = await import('zustand/vanilla');
    const { useSyncExternalStore } = await import('react');
    const create = (initializer: StateCreator<unknown>) => {
        const store = createStore(initializer);
        return Object.assign((selector: (state: unknown) => unknown = state => state) => (
            useSyncExternalStore(store.subscribe, () => selector(store.getState()))
        ), store);
    };
    return { create };
});
vi.mock('zustand/react/shallow', async () => {
    const { useRef } = await import('react');
    const { shallow } = await import('zustand/vanilla/shallow');
    return { useShallow: (selector: (state: unknown) => unknown) => {
        const previous = useRef<unknown>(undefined);
        return (state: unknown) => {
            const next = selector(state);
            return shallow(previous.current, next) ? previous.current : (previous.current = next);
        };
    } };
});

const { useCommandPaletteContext } = await import('@/hooks/useCommandPaletteContext');
const { usePlaybackEntryViewStore } = await import('@/stores/usePlaybackEntryViewStore');
const { settingsCommands } = await import('@/components/command-palette/commands/settingsCommands');

const deps = {} as CommandPaletteContextDeps;
const segmentation = { save: vi.fn(async () => undefined), reset: vi.fn(async () => undefined) };
let context: CommandPaletteContext;

const render = () => {
    runtime.cursor = 0;
    runtime.dirty = false;
    context = useCommandPaletteContext(deps, segmentation);
};
const flushSubscribedUpdate = () => { if (runtime.dirty) render(); };
const entryCommand = (view: 'player' | 'lattice') => (
    settingsCommands.find(command => command.id === `playback-entry-view-${view}`)!
);

beforeEach(() => {
    runtime.slots.length = 0;
    runtime.cursor = 0;
    runtime.dirty = false;
    usePlaybackEntryViewStore.setState({
        playbackEntryView: 'player',
        hasChosenPlaybackEntryView: false,
        isPlaybackEntryViewPromptOpen: false,
    });
});
afterEach(() => {
    runtime.slots.forEach(slot => slot.unsubscribe?.());
    runtime.slots.length = 0;
    usePlaybackEntryViewStore.setState(usePlaybackEntryViewStore.getInitialState());
});

describe('playback entry preference command context', () => {
    it('updates availability on a settings change and allows immediately switching back by command', () => {
        render();
        expect(context.settings.playbackEntryView).toBe('player');
        expect(entryCommand('player').isAvailable?.(context)).toBe(false);
        expect(entryCommand('lattice').isAvailable?.(context)).toBe(true);

        usePlaybackEntryViewStore.getState().setPlaybackEntryView('lattice');
        flushSubscribedUpdate();
        expect(context.settings.playbackEntryView).toBe('lattice');
        expect(entryCommand('player').isAvailable?.(context)).toBe(true);
        expect(entryCommand('lattice').isAvailable?.(context)).toBe(false);

        expect(entryCommand('player').execute('', context)).toBe(true);
        flushSubscribedUpdate();
        expect(usePlaybackEntryViewStore.getState().playbackEntryView).toBe('player');
        expect(context.settings.playbackEntryView).toBe('player');
        expect(entryCommand('player').isAvailable?.(context)).toBe(false);
        expect(entryCommand('lattice').isAvailable?.(context)).toBe(true);
    });

    it('does not rebuild the context for unrelated prompt state', () => {
        render();
        const previous = context;
        usePlaybackEntryViewStore.getState().requestPlaybackEntryViewPrompt();
        expect(runtime.dirty).toBe(false);
        flushSubscribedUpdate();
        expect(context).toBe(previous);
    });
});
