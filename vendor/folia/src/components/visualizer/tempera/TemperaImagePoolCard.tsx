import React from 'react';
import { ArrowUpRight, Images } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TemperaLayerImage } from '../../../types';
import { temperaDialogTokens, temperaDialogTextVars } from './temperaDialogTokens';
import { temperaPercent } from './temperaWorkshopModel';

// src/components/visualizer/tempera/TemperaImagePoolCard.tsx
// Discoverable entry shared by settings and the command palette; no new player or asset store.
export default function TemperaImagePoolCard({ images, thumbnails, frequency, isDaylight, onOpen }: {
    images: TemperaLayerImage[]; thumbnails: Map<string, string>; frequency: number;
    isDaylight: boolean; onOpen: () => void;
}) {
    const { t } = useTranslation();
    const tokens = temperaDialogTokens(isDaylight);
    return <button type="button" onClick={onOpen} className={`tempera-workshop-entry ${tokens.hoverSurfaceClass}`}
        style={{ ...temperaDialogTextVars(tokens), borderColor: tokens.line, backgroundColor: tokens.surface }}>
        <span className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm font-semibold"><Images size={18} />{t('options.temperaWorkshopTitle')}</span>
            <ArrowUpRight size={17} className="shrink-0 opacity-60" />
        </span>
        <span className="block text-xs leading-relaxed" style={{ color: tokens.textSecondary }}>{t('options.temperaWorkshopEntry')}</span>
        {images.length > 0 && <span className="flex min-w-0 gap-2 overflow-hidden" aria-hidden="true">
            {images.slice(0, 4).map(image => <span key={image.id} className="h-12 w-12 shrink-0 overflow-hidden rounded-lg" style={{ background: tokens.surface }}>
                {thumbnails.get(image.id) && <img src={thumbnails.get(image.id)} alt="" className="h-full w-full object-contain" />}
            </span>)}
        </span>}
        <span className="flex flex-wrap justify-between gap-2 text-xs" style={{ color: tokens.textSecondary }}>
            <span>{t('options.temperaWorkshopCount', { count: images.length })}</span>
            <span>{t('options.temperaLayerImageFrequency')} · {temperaPercent(frequency)}</span>
        </span>
    </button>;
}
