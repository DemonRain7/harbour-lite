import { expect, test } from './fixtures';
// test/component/grid3DToolbar.spec.ts

test('collection overview stays separate from scaled cards when the host is resized', async ({ mount, page }) => {
    const component = await mount('grid3DToolbar');
    const overview = component.getByRole('button', { name: 'All', exact: true });
    for (const style of ['Card', 'Image']) {
        await component.getByRole('button', { name: `${style} style` }).click();
        for (const viewport of [
            { width: 1600, height: 1000 },
            { width: 1440, height: 900 },
            { width: 1280, height: 820 },
            { width: 1000, height: 700 },
            { width: 800, height: 620 },
            { width: 2560, height: 1440 },
        ]) {
            await page.setViewportSize(viewport);
            await expect(async () => {
                const button = await overview.boundingBox();
                const card = await component.locator('[data-grid3d-index="2"]').boundingBox();
                const slider = await component.locator('[data-grid3d-slider]').boundingBox();
                const caption = await component.locator('[data-grid3d-caption]').boundingBox();
                expect(button).not.toBeNull();
                expect(card).not.toBeNull();
                expect(card!.y - button!.y - button!.height, `${style} ${viewport.width}×${viewport.height} clearance`).toBeGreaterThanOrEqual(12);
                expect(card!.y).toBeGreaterThanOrEqual(slider!.y);
                expect(card!.y + card!.height).toBeLessThanOrEqual(slider!.y + slider!.height);
                expect(card!.y + card!.height).toBeLessThanOrEqual(caption!.y);
            }).toPass({ timeout: 5000 });
            // Check the whole pill, not just its center. A small overlap can still let center clicks pass.
            expect(await overview.evaluate(button => {
                const box = button.getBoundingClientRect();
                return [0.15, 0.5, 0.85].every(x => [0.2, 0.8].every(y =>
                    button.contains(document.elementFromPoint(box.x + box.width * x, box.y + box.height * y))));
            })).toBe(true);
            if (style === 'Card' && viewport.width === 1280) {
                await component.screenshot({ path: 'test-results/grid3d-toolbar-compact.png' });
            }
        }
    }
});

test('overview opens and returns; wrapped actions and both themes keep real click targets', async ({ mount, page }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    const component = await mount('grid3DToolbar');
    const overview = component.getByRole('button', { name: 'All', exact: true });
    const card = component.locator('[data-grid3d-index="2"]');
    for (const floating of [true, false]) {
        if (!floating) await component.getByRole('button', { name: 'Toggle player' }).click();
        for (const width of [1000, 640, 1600]) {
            await page.setViewportSize({ width, height: 780 });
            await overview.click();
            await expect(component.getByRole('button', { name: 'All collections' })).toBeVisible();
            await component.getByRole('button').filter({ has: page.locator('svg.lucide-chevron-left') }).first().click();
            await expect(component.getByRole('button', { name: 'All collections' })).toHaveCount(0);
            await card.click();
            await expect(component.getByTestId('selected-collection')).toHaveText('probe-2');
        }
    }
    await component.getByRole('button', { name: 'Toggle actions' }).click();
    for (const width of [1440, 800, 640]) {
        await page.setViewportSize({ width, height: 780 });
        await component.getByRole('button', { name: 'Toggle daylight' }).click();
        await expect(async () => {
            const toolbar = await component.locator('[data-grid3d-toolbar]').boundingBox();
            const focused = await card.boundingBox();
            expect(focused!.y - toolbar!.y - toolbar!.height).toBeGreaterThanOrEqual(0);
        }).toPass();
        await component.getByRole('button', { name: 'Refresh library' }).click();
        await expect(component.getByTestId('selected-collection')).toHaveText('Refresh library');
        await overview.click();
        await component.getByRole('button').filter({ has: page.locator('svg.lucide-chevron-left') }).first().click();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await component.getByRole('button', { name: 'Toggle actions' }).click();
    await component.screenshot({ path: 'test-results/grid3d-toolbar-clearance.png' });
});

test('late metadata cannot grow an already centered card into the toolbar or clip its frame', async ({ mount, page }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    const component = await mount('grid3DToolbar');
    const card = component.locator('[data-grid3d-index="2"]');
    await expect(card).toContainText('Playlist');
    await component.getByRole('button', { name: 'Toggle metadata' }).click();
    await expect(card).toContainText('A longer album description');
    await expect(async () => {
        const box = await card.boundingBox();
        const slider = await component.locator('[data-grid3d-slider]').boundingBox();
        expect(box!.y).toBeGreaterThanOrEqual(slider!.y);
        expect(box!.y + box!.height).toBeLessThanOrEqual(slider!.y + slider!.height);
    }).toPass();
    await component.getByRole('button', { name: 'All', exact: true }).click();
    await expect(component.getByRole('button', { name: 'All collections' })).toBeVisible();
});
