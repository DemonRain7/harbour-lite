import { Repeat, Repeat1, RepeatOff, Shuffle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { StageLoopMode } from '../../types';

// Playback controls share one discrete mode label/icon; queue shuffling remains a separate action.
const PLAYBACK_MODE_APPEARANCE: Record<StageLoopMode, { icon: LucideIcon; labelKey: string }> = {
    off: { icon: RepeatOff, labelKey: 'ui.playbackMode_off' },
    all: { icon: Repeat, labelKey: 'ui.playbackMode_all' },
    one: { icon: Repeat1, labelKey: 'ui.playbackMode_one' },
    shuffle: { icon: Shuffle, labelKey: 'ui.playbackMode_shuffle' },
};

export const resolvePlaybackModeAppearance = (mode: StageLoopMode) => PLAYBACK_MODE_APPEARANCE[mode];
