import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TEMPERA_LAYER_IMAGE } from '../../../src/types';
import { sameTemperaPool, temperaAlignmentAt, temperaPercent, unusedTemperaDraftIds } from '../../../src/components/visualizer/tempera/temperaWorkshopModel';
import { buildStoredTemperaLayerImage } from '../../../src/services/temperaLayerImages';

// test/unit/visualizer/temperaWorkshopModel.test.ts
vi.mock('../../../src/services/db', () => ({ getFromCache: vi.fn(), removeFromCache: vi.fn(), saveToCache: vi.fn() }));
const image = { ...DEFAULT_TEMPERA_LAYER_IMAGE, id: 'a', name: 'art.svg' };
const pool = { layerImages: [image], layerImageDepth: 'back' as const, layerImageFrequency: 0.8 };
describe('Tempera workshop model', () => {
    it('snaps all nine regions to existing renderer fields', () => {
        for (const [x, align] of ['left', 'center', 'right'].entries()) {
            for (const [y, verticalAlign] of ['top', 'center', 'bottom'].entries()) {
                expect(temperaAlignmentAt((x + .5) / 3, (y + .5) / 3)).toEqual({ align, verticalAlign });
            }
        }
    });
    it('clamps out-of-stage dragging and handles invalid coordinates', () => {
        expect(temperaAlignmentAt(-10, 10)).toEqual({ align: 'left', verticalAlign: 'bottom' });
        expect(temperaAlignmentAt(NaN, Infinity)).toEqual({ align: 'center', verticalAlign: 'center' });
    });
    it('compares all persistent fields but not object identities', () => {
        expect(sameTemperaPool(pool, structuredClone(pool))).toBe(true);
        for (const patch of [{ align: 'right' as const }, { verticalAlign: 'top' as const }, { scale: 1.5 },
            { opacity: .2 }, { name: 'new.png' }, { id: 'b' }]) {
            expect(sameTemperaPool(pool, { ...pool, layerImages: [{ ...image, ...patch }] })).toBe(false);
        }
        expect(sameTemperaPool(pool, { ...pool, layerImageFrequency: 0 })).toBe(false);
        expect(sameTemperaPool(pool, { ...pool, layerImageDepth: 'front' })).toBe(false);
        expect(sameTemperaPool(pool, { ...pool, layerImages: [] })).toBe(false);
    });
    it('reclaims only this draft’s unused records', () => {
        expect(unusedTemperaDraftIds(['new-a', 'new-a', 'a', 'new-b'], [image])).toEqual(['new-a', 'new-b']);
        expect(unusedTemperaDraftIds([], [image])).toEqual([]);
    });
    it('displays percentages without the old multiplier suffix', () => {
        expect(temperaPercent(.8)).toBe('80%');
        expect(temperaPercent(0)).toBe('0%');
        expect(temperaPercent(1.5)).toBe('150%');
    });
    it('gives same-named uploads distinct ids without changing file metadata', () => {
        const file = new File(['<svg/>'], 'art.svg', { type: 'image/svg+xml' });
        const first = buildStoredTemperaLayerImage(file), second = buildStoredTemperaLayerImage(file);
        expect(first.id).not.toBe(second.id);
        expect(first.name).toBe(file.name);
        expect(first.blob).toBe(file);
    });
});
