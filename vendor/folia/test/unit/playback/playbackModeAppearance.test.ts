import { describe, expect, it, vi } from 'vitest';
import { Repeat, Repeat1, RepeatOff, Shuffle } from 'lucide-react';
import { resolvePlaybackModeAppearance } from '../../../src/components/shared/playbackModeAppearance';
import { resolvePlayerControlSlot, type PlayerControlSlotContext } from '../../../src/components/floating-player/playerControlSlotActions';
import en from '../../../src/i18n/locales/en';
import zhCN from '../../../src/i18n/locales/zh-CN';
import id from '../../../src/i18n/locales/in';

// Native player and Remote controls share all four labels/icons without turning queue shuffle into a mode.
describe('playback mode appearance', () => {
    it.each([
        ['off', RepeatOff], ['all', Repeat], ['one', Repeat1], ['shuffle', Shuffle],
    ] as const)('resolves %s with a translated, distinct mode label', (mode, icon) => {
        const appearance = resolvePlaybackModeAppearance(mode);
        expect(appearance.icon).toBe(icon);
        expect(appearance.labelKey).toBe(`ui.playbackMode_${mode}`);
        for (const locale of [en, zhCN, id]) {
            expect(locale.ui[`playbackMode_${mode}`]).toBeTruthy();
        }
    });

    it('keeps the persistent mode action separate from a one-time queue shuffle', () => {
        const onToggleLoop = vi.fn();
        const onShuffle = vi.fn();
        const context = { loopMode: 'shuffle', onToggleLoop, onShuffle, canShuffle: true } as unknown as PlayerControlSlotContext;
        const mode = resolvePlayerControlSlot('loop', context);
        const shuffleQueue = resolvePlayerControlSlot('shuffle', context);
        expect(mode.active).toBe(true);
        expect(mode.labelKey).toBe('ui.playbackMode_shuffle');
        expect(shuffleQueue.active).toBe(false);
        expect(shuffleQueue.labelKey).toBe('options.playerControlSlotAction_shuffle');
        mode.onActivate();
        shuffleQueue.onActivate();
        expect(onToggleLoop).toHaveBeenCalledOnce();
        expect(onShuffle).toHaveBeenCalledOnce();
    });

    it('disables mode changes when the source owns the playback order', () => {
        const context = { loopMode: 'off', canToggleLoop: false } as unknown as PlayerControlSlotContext;
        expect(resolvePlayerControlSlot('loop', context).disabled).toBe(true);
    });
});
