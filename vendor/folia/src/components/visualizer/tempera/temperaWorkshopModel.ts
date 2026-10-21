import type { TemperaLayerImage } from '../../../types';

// src/components/visualizer/tempera/temperaWorkshopModel.ts
// Editing uses the existing tendency fields, never a second set of absolute coordinates.
export interface TemperaImageLayerCommit {
    layerImages: TemperaLayerImage[];
    layerImageDepth: 'back' | 'front';
    layerImageFrequency: number;
}

export const sameTemperaPool = (a: TemperaImageLayerCommit, b: TemperaImageLayerCommit) => (
    a.layerImageDepth === b.layerImageDepth && a.layerImageFrequency === b.layerImageFrequency
    && a.layerImages.length === b.layerImages.length
    && a.layerImages.every((image, i) => {
        const other = b.layerImages[i];
        return image.id === other.id && image.name === other.name && image.align === other.align
            && image.verticalAlign === other.verticalAlign && image.scale === other.scale && image.opacity === other.opacity;
    })
);

/** Snap a click/drag to the renderer's existing 3×3 tendency bands. */
export const temperaAlignmentAt = (x: number, y: number): Pick<TemperaLayerImage, 'align' | 'verticalAlign'> => {
    const cell = (value: number) => Math.max(0, Math.min(2, Math.floor((Number.isFinite(value) ? value : 0.5) * 3)));
    return { align: (['left', 'center', 'right'] as const)[cell(x)],
        verticalAlign: (['top', 'center', 'bottom'] as const)[cell(y)] };
};

/** Only records created by this draft may be removed on cancel/unmount. */
export const unusedTemperaDraftIds = (created: Iterable<string>, retained: TemperaLayerImage[]) => {
    const keep = new Set(retained.map(image => image.id));
    return [...new Set(created)].filter(id => !keep.has(id));
};

export const temperaPercent = (value: number) => `${Math.round(value * 100)}%`;
