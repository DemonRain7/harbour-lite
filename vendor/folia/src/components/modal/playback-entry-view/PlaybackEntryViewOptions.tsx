import React from 'react';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LatticeViewArt, PlayerViewArt } from './playbackEntryViewArt';
import type { PlaybackEntryView } from '../../../stores/usePlaybackEntryViewStore';

// src/components/modal/playback-entry-view/PlaybackEntryViewOptions.tsx
// The two picture-and-text cards for choosing where playback opens.
//
// Shared by the one-time prompt and the settings section so the two cannot drift: the prompt is
// most people's only look at this choice, and the settings copy has to describe the same thing.

type PlaybackEntryViewOptionsProps = {
    value: PlaybackEntryView;
    onChange: (view: PlaybackEntryView) => void;
    isDaylight: boolean;
    accentColor: string;
};

const OPTIONS: Array<{ value: PlaybackEntryView; art: typeof PlayerViewArt; i18nKey: string }> = [
    { value: 'player', art: PlayerViewArt, i18nKey: 'player' },
    { value: 'lattice', art: LatticeViewArt, i18nKey: 'lattice' },
];

export const PlaybackEntryViewOptions: React.FC<PlaybackEntryViewOptionsProps> = ({
    value,
    onChange,
    isDaylight,
    accentColor,
}) => {
    const { t } = useTranslation();

    return (
        <div className="grid grid-cols-2 gap-3">
            {OPTIONS.map(({ value: optionValue, art: Art, i18nKey }) => {
                const isSelected = value === optionValue;
                const frameClass = isSelected
                    ? (isDaylight ? 'bg-white shadow-md' : 'bg-white/[0.07]')
                    : (isDaylight ? 'bg-zinc-50 hover:bg-white' : 'bg-white/[0.03] hover:bg-white/[0.06]');

                return (
                    <button
                        key={optionValue}
                        type="button"
                        onClick={() => onChange(optionValue)}
                        aria-label={t(`playbackEntryView.${i18nKey}.title`)}
                        aria-pressed={isSelected}
                        className={`relative min-w-0 text-left rounded-2xl border p-3 transition-colors ${frameClass}`}
                        style={{
                            borderColor: isSelected
                                ? accentColor
                                : (isDaylight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)'),
                        }}
                    >
                        {isSelected && <span
                            className="absolute top-2 right-2 flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold shadow-sm"
                            style={{ backgroundColor: isDaylight ? '#fff' : '#18181b', color: accentColor, border: '1px solid currentColor' }}
                        >
                            <Check size={12} aria-hidden="true" />{t('playbackEntryView.selected')}
                        </span>}
                        <Art
                            accentColor={accentColor}
                            className={`w-full h-auto rounded-lg ${isDaylight ? 'text-zinc-900' : 'text-zinc-100'}`}
                        />
                        <div className="mt-3 text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                            {t(`playbackEntryView.${i18nKey}.title`)}
                        </div>
                        <div className="mt-1 text-[11px] leading-relaxed opacity-60" style={{ color: 'var(--text-secondary)' }}>
                            {t(`playbackEntryView.${i18nKey}.description`)}
                        </div>
                    </button>
                );
            })}
        </div>
    );
};
