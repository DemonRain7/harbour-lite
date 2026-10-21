import { useState, type CSSProperties } from 'react';
import { AnimatePresence, useMotionValue } from 'framer-motion';
import SettingsModal from '../../src/components/modal/SettingsModal';
import { BASE_DUAL_THEME } from '../../src/services/baseThemes';
import type { ProbeDefinition } from './definition';

// Real help/options modal, with isolated settings and no account or playback network.
const noop = () => {};

function SettingsModalLayoutProbe({ daylight = false }: { daylight?: boolean }) {
    const [open, setOpen] = useState(true);
    const time = useMotionValue(0);
    const theme = daylight ? BASE_DUAL_THEME.light : BASE_DUAL_THEME.dark;
    return (
        <div style={{ '--text-primary': theme.primaryColor, '--text-secondary': theme.secondaryColor,
            '--scrollbar-track': 'transparent', '--scrollbar-thumb': theme.secondaryColor,
            background: theme.backgroundColor, minHeight: '100vh' } as CSSProperties}>
            <button onClick={() => setOpen(true)}>Open settings fixture</button>
            <AnimatePresence>
                {open && <SettingsModal
                    onClose={() => setOpen(false)}
                    theme={theme}
                    bgMode="default"
                    onApplyDefaultTheme={noop}
                    hasCustomTheme={false}
                    themeParkInitialTheme={BASE_DUAL_THEME}
                    isCustomThemePreferred={false}
                    songThemeAutoSwitchEnabled={false}
                    songThemeAutoGenerateEnabled={false}
                    onSaveCustomTheme={noop}
                    onSaveAiTheme={noop}
                    onApplyCustomTheme={noop}
                    onToggleCustomThemePreferred={noop}
                    onToggleSongThemeAutoSwitch={noop}
                    themeGenerationSource="cover"
                    onChangeThemeGenerationSource={noop}
                    onToggleSongThemeAutoGenerate={noop}
                    loadLyricFilterPreview={async () => null}
                    currentLyrics={null}
                    lyricCurrentTime={time}
                    onSaveLyricFilterPattern={noop}
                    onAudioOutputDeviceChange={() => true}
                    replayGainMode="off"
                    onReplayGainModeChange={noop}
                />}
            </AnimatePresence>
        </div>
    );
}

export default {
    id: 'settingsModalLayout',
    title: 'Help and options modal viewport',
    description: 'Full modal scrolling, compact viewports, tabs and close controls',
    Component: SettingsModalLayoutProbe,
} satisfies ProbeDefinition;
