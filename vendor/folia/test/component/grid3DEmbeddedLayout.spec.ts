import { expect, test } from './fixtures';

// test/component/grid3DEmbeddedLayout.spec.ts

test('embedded and standalone hosts retain the same balanced collection distribution', async ({ mount, page }) => {
    await page.setViewportSize({ width: 2048, height: 1098 });
    const component = await mount('grid3DToolbar');
    await component.getByRole('button', { name: 'Card style', exact: true }).click();
    const host = component.getByTestId('embedded-folia');
    const metrics: unknown[] = [];
    for (const size of [
        { width: 1640, height: 900 },
        { width: 1560, height: 828 },
        { width: 1248, height: 662 },
        // Open/close the queue without losing the selected collection.
        { width: 998, height: 662 },
        { width: 1248, height: 662 },
        { width: 1640, height: 900 },
    ]) {
        await host.evaluate((element, value) => {
            Object.assign((element as HTMLElement).style, {
                flex: 'none', width: `${value.width}px`, height: `${value.height}px`,
            });
        }, size);
        await expect(async () => {
            const focus = (await component.locator('[data-grid3d-index="2"]').boundingBox())!;
            const side = (await component.locator('[data-grid3d-index="3"]').boundingBox())!;
            const slider = (await component.locator('[data-grid3d-slider]').boundingBox())!;
            const pitch = side.x + side.width / 2 - focus.x - focus.width / 2;
            // The old 1248×662 host shrank the focal card to 19% of its width,
            // but left the neighbors 1.48 card-widths apart. Check both ratios.
            expect(focus.width / slider.width).toBeGreaterThan(0.23);
            expect(focus.width / slider.width).toBeLessThan(0.30);
            expect(pitch / focus.width).toBeGreaterThan(0.90);
            expect(pitch / focus.width).toBeLessThan(1.06);
            expect(side.width / focus.width).toBeGreaterThan(0.5);
            expect(side.width / focus.width).toBeLessThan(0.74);
            expect(Math.abs(focus.x + focus.width / 2 - slider.x - slider.width / 2)).toBeLessThan(2);
            expect(await component.locator('[data-grid3d-caption] h3').innerText()).toBe('日语');
            const overview = (await component.locator('[data-grid3d-toolbar]').boundingBox())!;
            const caption = (await component.locator('[data-grid3d-caption]').boundingBox())!;
            expect(focus.y - overview.y - overview.height).toBeGreaterThan(8);
            expect(caption.y - focus.y - focus.height).toBeGreaterThan(16);
        }).toPass({ timeout: 5000 });
        metrics.push({ size, card: await component.locator('[data-grid3d-index="2"]').boundingBox() });
        await host.screenshot({ path: `test-results/grid3d-host-distribution-${size.width}.png` });
    }
    console.log('Grid3D host distribution:', JSON.stringify(metrics));
    // Moving between hosts does not just look centered: pointer selection still
    // opens the displayed playlist, and keyboard navigation uses the new pitch.
    await component.locator('[data-grid3d-slider]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(component.locator('[data-grid3d-caption] h3')).toHaveText('Rain');
    await expect(async () => {
        const focus = (await component.locator('[data-grid3d-index="3"]').boundingBox())!;
        const slider = (await component.locator('[data-grid3d-slider]').boundingBox())!;
        expect(Math.abs(focus.x + focus.width / 2 - slider.x - slider.width / 2)).toBeLessThan(2);
    }).toPass();
    await component.locator('[data-grid3d-index="3"]').click();
    await expect(component.getByTestId('selected-collection')).toHaveText('probe-3');
});
