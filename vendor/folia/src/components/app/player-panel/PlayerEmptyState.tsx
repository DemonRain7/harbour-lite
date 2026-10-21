import { Music2, ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Theme } from '../../../types';
import { useSettingsModalStore } from '../../../stores/useSettingsModalStore';

// Keep the empty player navigable without depending on a visualizer's hidden
// hover target. Stage has its own waiting state; paused songs are not empty.
export default function PlayerEmptyState({ theme, isDaylight, onBack }: {
    theme: Theme;
    isDaylight: boolean;
    onBack: () => void;
}) {
    const { t } = useTranslation();
    const settingsOpen = useSettingsModalStore(state => state.settingsModalState.isOpen);
    if (settingsOpen) return null;
    return (
        <div className="absolute inset-0 z-10 flex items-center justify-center px-6 pointer-events-none">
            <section
                data-testid="player-empty-state"
                className={`max-w-sm rounded-3xl border px-8 py-7 text-center backdrop-blur-xl pointer-events-auto ${isDaylight ? 'border-black/10 bg-white/60' : 'border-white/10 bg-black/40'}`}
                style={{ color: theme.primaryColor }}
            >
                <Music2 className="mx-auto mb-4 opacity-60" size={30} aria-hidden="true" />
                <h2 className="text-lg font-semibold">{t('panel.emptyTitle')}</h2>
                <p className="mt-2 text-sm leading-relaxed opacity-70">{t('panel.emptyDescription')}</p>
                <button
                    type="button"
                    data-testid="player-empty-back"
                    onClick={onBack}
                    className={`mt-5 inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 ${isDaylight ? 'bg-black/10 hover:bg-black/15' : 'bg-white/10 hover:bg-white/20'}`}
                >
                    <ArrowLeft size={16} aria-hidden="true" />{t('panel.backToLibrary')}
                </button>
            </section>
        </div>
    );
}
