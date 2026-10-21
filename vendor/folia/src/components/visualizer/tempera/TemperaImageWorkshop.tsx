import React, { useState } from 'react';
import { ImagePlus, Images } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { TemperaLayerImage } from '../../../types';
import TemperaImagePlacementEditor from './TemperaImagePlacementEditor';
import { TemperaRangeControl } from './TemperaSettingsControls';
import type { TemperaDialogTokens } from './temperaDialogTokens';
import { temperaPercent } from './temperaWorkshopModel';

// src/components/visualizer/tempera/TemperaImageWorkshop.tsx
// A bounded (16-image) gallery selects one editor; no hidden per-image canvases or animation loops.
interface Props {
    images: TemperaLayerImage[]; thumbnails: Map<string, string>; depth: 'back' | 'front'; frequency: number;
    maxImages: number; disabled: boolean; t: TFunction; tokens: TemperaDialogTokens; rangeInputClass: string;
    onAdd: () => void; onPatch: (id: string, patch: Partial<TemperaLayerImage>) => void; onRemove: (id: string) => void;
    onDepthChange: (depth: 'back' | 'front') => void; onFrequencyChange: (frequency: number) => void;
}

export default function TemperaImageWorkshop(props: Props) {
    const { images, thumbnails, depth, frequency, tokens, t, maxImages, disabled } = props;
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const selected = images.find(image => image.id === selectedId) ?? images[0];
    return <div className="space-y-5" data-tempera-workshop-body="true">
        <div className="tempera-workshop-layout">
            <aside className="tempera-workshop-library space-y-3">
                <div className="flex items-center justify-between text-sm font-medium">
                    <span>{t('options.temperaWorkshopLibrary')}</span>
                    <span className="font-mono text-xs" style={{ color: tokens.textSecondary }}>{images.length} / {maxImages}</span>
                </div>
                <button type="button" onClick={props.onAdd} disabled={disabled || images.length >= maxImages}
                    className={`flex w-full items-center justify-center gap-2 rounded-xl border border-dashed px-3 py-3 text-xs disabled:opacity-40 ${tokens.hoverSurfaceClass}`}
                    style={{ borderColor: tokens.lineStrong }}><ImagePlus size={16} />{t('options.temperaAddLayerImage')}</button>
                <div className="tempera-workshop-gallery" aria-label={t('options.temperaWorkshopLibrary')}>
                    {images.map(image => <button key={image.id} type="button" disabled={disabled} data-image-id={image.id}
                        aria-pressed={selected?.id === image.id} onClick={() => setSelectedId(image.id)}
                        className={`tempera-workshop-asset ${tokens.hoverSurfaceClass}`} title={image.name}
                        style={{ borderColor: selected?.id === image.id ? tokens.accent : tokens.line,
                            backgroundColor: selected?.id === image.id ? tokens.surface : 'transparent' }}>
                        {thumbnails.get(image.id) ? <img src={thumbnails.get(image.id)} alt="" />
                            : <Images size={24} className="mx-auto my-6 opacity-40" />}
                        <span className="mt-1 block truncate text-[11px]">{image.name}</span>
                    </button>)}
                </div>
                <p className="text-xs leading-relaxed" style={{ color: tokens.textSecondary }}>{t('options.temperaWorkshopLocalHint')}</p>
            </aside>
            {selected ? <TemperaImagePlacementEditor key={selected.id} image={selected} thumbnail={thumbnails.get(selected.id)}
                depth={depth} t={t} tokens={tokens} rangeInputClass={props.rangeInputClass} onPatch={props.onPatch} onRemove={props.onRemove} />
                : <div className="flex min-h-[260px] flex-col items-center justify-center gap-4 rounded-2xl border border-dashed p-7 text-center"
                    style={{ borderColor: tokens.line, background: tokens.surface }}>
                    <Images size={36} strokeWidth={1.3} />
                    <h3 className="text-lg font-medium">{t('options.temperaWorkshopEmptyTitle')}</h3>
                    <p className="max-w-sm text-sm leading-relaxed" style={{ color: tokens.textSecondary }}>{t('options.temperaLayerImageEmpty')}</p>
                </div>}
        </div>
        <div className="tempera-workshop-pool" style={{ borderColor: tokens.line }}>
            <div className="space-y-2">
                <p className="text-sm">{t('options.temperaLayerImageDepth')}</p>
                <div className="flex flex-wrap gap-2">
                    {(['back', 'front'] as const).map(value => <button key={value} type="button" aria-pressed={depth === value}
                        onClick={() => props.onDepthChange(value)} className={`rounded-full border px-4 py-2 text-xs ${tokens.hoverSurfaceClass}`}
                        style={{ borderColor: depth === value ? tokens.accent : tokens.line,
                            background: depth === value ? tokens.surface : 'transparent' }}>
                        {t(value === 'back' ? 'options.temperaLayerImageBack' : 'options.temperaLayerImageFront')}
                    </button>)}
                </div>
            </div>
            <div className="space-y-2">
                <TemperaRangeControl label={t('options.temperaLayerImageFrequency')} value={frequency}
                    min={0} max={1} step={0.05} formatValue={temperaPercent} rangeInputClass={props.rangeInputClass} onChange={props.onFrequencyChange} />
                <p className="text-xs leading-relaxed" style={{ color: tokens.textSecondary }}>
                    {t(frequency === 0 ? 'options.temperaWorkshopFrequencyOff' : 'options.temperaWorkshopFrequencyHint')}
                </p>
            </div>
        </div>
    </div>;
}
