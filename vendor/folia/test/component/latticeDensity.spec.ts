import type { Locator } from '@playwright/test';
import { expect, test } from './fixtures';

// vendor/folia/test/component/latticeDensity.spec.ts
// Measure visible cards in the real scaled wall, separately from its preloaded DOM cards.
const sampleWall = (wall: Locator) => wall.locator('.lattice-field').evaluate(field => {
    const view = field.getBoundingClientRect();
    const camera = new DOMMatrix(getComputedStyle(field.querySelector('.lattice-world')!).transform);
    const posters = [...field.querySelectorAll('.lattice-poster')];
    const visible = posters.filter(poster => {
        const rect = poster.getBoundingClientRect();
        return rect.left < view.right && rect.right > view.left && rect.top < view.bottom && rect.bottom > view.top;
    });
    // Reject holes/overlays throughout the viewport, not just near its first rows. A sample may
    // land in the intended tile gap; adjacent probes cover only that gap, never a missing card.
    const gap = 8 * camera.a + 1;
    const offsets = [0, -gap, gap];
    const covered = [];
    for (let y = 0.2; y <= 0.8; y += 0.2) for (let x = 0.2; x <= 0.8; x += 0.2) {
        covered.push(offsets.some(dx => offsets.some(dy => Boolean(document.elementFromPoint(
            view.left + view.width * x + dx, view.top + view.height * y + dy,
        )?.closest('.lattice-poster')))));
    }
    return {
        visible: visible.length, mounted: posters.length, covered: covered.filter(Boolean).length,
        centerX: (view.width / 2 - camera.m41) / camera.a,
        centerY: (view.height / 2 - camera.m42) / camera.a,
    };
});

test('the desktop wall shows about 30 cards at multiple sizes and after panning', async ({ mount, page }, testInfo) => {
    await page.setViewportSize({ width: 2560, height: 1440 });
    const wall = await mount('harbourLatticePerformance', { queueSize: 1200 });
    await expect(wall.locator('.lattice-lyrics.is-ready canvas')).toHaveCount(1);
    await page.waitForTimeout(1500);
    const canvas = wall.locator('.lattice-lyrics canvas');
    await canvas.evaluate(node => node.setAttribute('data-density-original', 'true'));
    const samples = [];
    for (const size of [{ width: 2560, height: 1440 }, { width: 1440, height: 850 }, { width: 1024, height: 768 }]) {
        const before = await sampleWall(wall);
        await page.setViewportSize(size);
        await page.waitForTimeout(500);
        const resized = await sampleWall(wall);
        expect(resized.centerX).toBeCloseTo(before.centerX, 1);
        expect(resized.centerY).toBeCloseTo(before.centerY, 1);
        await expect(canvas).toHaveAttribute('data-density-original', 'true');
        for (let step = 0; step < 3; step++) {
            const sample = await sampleWall(wall);
            samples.push({ ...size, step, ...sample });
            expect(sample.visible).toBeGreaterThanOrEqual(23);
            expect(sample.visible).toBeLessThanOrEqual(37);
            expect(sample.mounted).toBeLessThan(400);
            expect(sample.covered).toBe(16);
            await wall.locator('.lattice-field').dispatchEvent('wheel', { deltaX: 711, deltaY: -313 });
            await page.waitForTimeout(300);
        }
        await wall.screenshot({ path: testInfo.outputPath(`density-${size.width}.png`) });
    }
    console.log('LATTICE_DENSITY', JSON.stringify(samples));
    await testInfo.attach('visible-card-counts.json', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
});
