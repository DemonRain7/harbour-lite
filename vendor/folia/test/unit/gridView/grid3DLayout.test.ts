import { describe, expect, it } from 'vitest';
import { resolveGrid3DLayout } from '../../../src/components/folia-grid/grid3DLayout';

// test/unit/gridView/grid3DLayout.test.ts

describe('Grid3D proportional host layout', () => {
    it.each([1.2, 1.25])('preserves the unconstrained desktop profile at peak %s', peak => {
        expect(resolveGrid3DLayout(400, 800, 64, peak)).toEqual({
            peakScale: peak, minScale: 0.5, cardPitch: 448, focusDistance: 600,
        });
    });

    it.each([1.2, 1.25])('fits cards, pitch and focus falloff together at peak %s', peak => {
        const desktop = resolveGrid3DLayout(400, 800, 64, peak);
        for (const height of [500, 380, 260]) {
            const embedded = resolveGrid3DLayout(400, height, 64, peak);
            const ratio = embedded.peakScale / desktop.peakScale;
            expect(embedded.peakScale * 464).toBeCloseTo(height - 32);
            expect(Number.isInteger(embedded.cardPitch)).toBe(true);
            expect(Math.abs(embedded.cardPitch - desktop.cardPitch * ratio)).toBeLessThanOrEqual(0.5);
            expect(embedded.focusDistance / desktop.focusDistance).toBeCloseTo(ratio);
            expect(embedded.minScale / embedded.peakScale).toBeCloseTo(desktop.minScale / desktop.peakScale);
        }
    });

    it('accounts for late metadata without changing the focus profile', () => {
        const initial = resolveGrid3DLayout(400, 450, 64, 1.2);
        const expanded = resolveGrid3DLayout(400, 450, 108, 1.2);
        expect(expanded.peakScale).toBeLessThan(initial.peakScale);
        expect(Math.abs(expanded.cardPitch - initial.cardPitch * expanded.peakScale / initial.peakScale)).toBeLessThan(1);
    });
});
