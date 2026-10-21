import { describe, expect, it } from 'vitest';
import { getLatticeGeometry, layoutLattice, MAX_RENDERED_INSTANCES } from '../../../src/components/app/lattice/layout';
import { getLatticeRenderOverscan, getLatticeViewportScale, TARGET_VISIBLE_POSTERS } from '../../../src/components/app/lattice/wallViewport';

// vendor/folia/test/unit/lattice/wallViewport.test.ts
// Count real template intersections, not render invocations or the offscreen buffer.
describe('desktop collage density', () => {
    const metrics = { cellSize: 128, gap: 8 };
    const geometry = getLatticeGeometry(1200, metrics);

    it.each([[1024, 768], [1440, 850], [1440, 1100], [1920, 1080], [2560, 1440]])(
        'fits about 30 posters at %i x %i without exhausting the render buffer', (width, height) => {
            const scale = getLatticeViewportScale(width, height, metrics);
            const counts: number[] = [];
            for (let index = 0; index < 32; index++) {
                const left = index * 1341 - 2200;
                const top = index * 981 - 1700;
                const bounds = { left, top, right: left + width / scale, bottom: top + height / scale };
                const visible = layoutLattice(geometry, 1200, bounds, 0, metrics);
                const overscan = getLatticeRenderOverscan(width, height, scale);
                const buffered = layoutLattice(geometry, 1200, bounds, overscan, metrics);
                counts.push(visible.length);
                // A few large tiles can occupy the same space as several small ones. Keep the
                // broad per-position bound separate from the tight mean-density requirement.
                expect(visible.length).toBeGreaterThanOrEqual(23);
                expect(visible.length).toBeLessThanOrEqual(37);
                expect(buffered.length).toBeLessThan(MAX_RENDERED_INSTANCES);
                const retained = new Set(buffered.map(card => card.instanceId));
                expect(visible.every(card => retained.has(card.instanceId))).toBe(true);
            }
            const average = counts.reduce((sum, count) => sum + count, 0) / counts.length;
            expect(Math.abs(average - TARGET_VISIBLE_POSTERS)).toBeLessThan(1);
        },
    );

    it('keeps the previous phone scale and rejects zero-height layout as a density measurement', () => {
        expect(getLatticeViewportScale(390, 844, metrics)).toBe(0.52);
        expect(getLatticeViewportScale(1440, 0, metrics)).toBe(0.52);
    });

    it('changes scale continuously instead of jumping at the old desktop breakpoint', () => {
        const before = getLatticeViewportScale(1099, 800, metrics);
        const after = getLatticeViewportScale(1100, 800, metrics);
        expect(Math.abs(after - before)).toBeLessThan(0.001);
    });

    it('keeps preload lead distance in screen pixels as the camera zoom changes', () => {
        for (const scale of [.52, .61, .85, 1.2]) {
            expect(getLatticeRenderOverscan(1440, 750, scale) * scale).toBeCloseTo(412.5);
        }
        expect(getLatticeRenderOverscan(390, 844, .52) * .52).toBe(320);
        expect(getLatticeRenderOverscan(3840, 2160, 1.2) * 1.2).toBe(480);
    });
});
