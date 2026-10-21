import React, { useState } from 'react';
import { Shuffle, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { TemperaLayerImage } from '../../../types';
import TemperaImagePreview from './TemperaImagePreview';
import { temperaPercent } from './temperaWorkshopModel';
import { TemperaRangeControl } from './TemperaSettingsControls';
import type { TemperaDialogTokens } from './temperaDialogTokens';

// src/components/visualizer/tempera/TemperaImagePlacementEditor.tsx
// Edits one image through the same seeded placement calculation used by the Pixi runtime.
// Colors arrive as the dialog's tokens: this renders inside a portal on document.body, where
// the shell's --text-* vars do not resolve - see temperaDialogTokens.
interface TemperaImagePlacementEditorProps {
    image: TemperaLayerImage;
    thumbnail?: string;
    depth: 'back' | 'front';
    t: TFunction;
    tokens: TemperaDialogTokens;
    rangeInputClass: string;
    onPatch: (id: string, next: Partial<TemperaLayerImage>) => void;
    onRemove: (id: string) => void;
}

interface ModeButtonProps {
    active: boolean;
    label: string;
    tokens: TemperaDialogTokens;
    onClick: () => void;
}

const ModeButton: React.FC<ModeButtonProps> = ({ active, label, tokens, onClick }) => (
    <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className="rounded-full border px-3 py-1.5 text-xs transition-colors"
        style={{
            borderColor: active ? tokens.textPrimary : tokens.line,
            color: tokens.textPrimary,
            opacity: active ? 1 : 0.55,
        }}
    >
        {label}
    </button>
);

const TemperaImagePlacementEditor: React.FC<TemperaImagePlacementEditorProps> = ({
    image,
    thumbnail,
    depth,
    t,
    tokens,
    rangeInputClass,
    onPatch,
    onRemove,
}) => {
    const [sample, setSample] = useState(0);

    return (
        <div className="min-w-0 space-y-3" style={{ color: tokens.textPrimary }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{t('options.temperaWorkshopPreview')}</span>
                <button type="button" onClick={() => setSample(value => value + 1)} className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${tokens.hoverSurfaceClass}`} style={{ borderColor: tokens.line }}>
                    <Shuffle size={13} />{t('options.temperaWorkshopNextShot')}
                </button>
            </div>
            <TemperaImagePreview image={image} thumbnail={thumbnail} sample={sample} depth={depth} tokens={tokens} t={t} onPatch={onPatch} />

            <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-sm" title={image.name}>{image.name}</span>
                    <button type="button" onClick={() => onRemove(image.id)} aria-label={t('options.temperaRemoveLayerImage')}
                        className={`shrink-0 rounded-full p-2 ${tokens.hoverSurfaceClass}`}><Trash2 size={15} /></button>
                </div>
                <p className="text-xs leading-relaxed" style={{ color: tokens.textSecondary }}>
                    {t('options.temperaWorkshopPlacementHint')}
                </p>
                <div className="flex flex-wrap gap-1.5">
                    <ModeButton
                        label={t('options.temperaLayerAlignVerticalRandom')}
                        tokens={tokens}
                        active={image.verticalAlign === 'free' && image.align !== 'free'}
                        onClick={() => onPatch(image.id, {
                            align: image.align === 'free' ? 'center' : image.align,
                            verticalAlign: 'free',
                        })}
                    />
                    <ModeButton
                        label={t('options.temperaLayerAlignHorizontalRandom')}
                        tokens={tokens}
                        active={image.align === 'free' && image.verticalAlign !== 'free'}
                        onClick={() => onPatch(image.id, {
                            align: 'free',
                            verticalAlign: image.verticalAlign === 'free' ? 'center' : image.verticalAlign,
                        })}
                    />
                    <ModeButton
                        label={t('options.temperaLayerAlignFree')}
                        tokens={tokens}
                        active={image.align === 'free' && image.verticalAlign === 'free'}
                        onClick={() => onPatch(image.id, { align: 'free', verticalAlign: 'free' })}
                    />
                </div>
            </div>

            <div className="tempera-workshop-controls"><TemperaRangeControl
                label={t('options.temperaLayerImageScale')}
                value={image.scale}
                min={0.05}
                max={2}
                step={0.01}
                rangeInputClass={rangeInputClass}
                formatValue={temperaPercent}
                onChange={scale => onPatch(image.id, { scale })}
            />
            <TemperaRangeControl
                label={t('options.temperaLayerImageOpacity')}
                value={image.opacity}
                min={0}
                max={1}
                step={0.01}
                rangeInputClass={rangeInputClass}
                formatValue={temperaPercent}
                onChange={opacity => onPatch(image.id, { opacity })}
            /></div>
        </div>
    );
};

export default React.memo(TemperaImagePlacementEditor);
