import { expect, test } from './fixtures';

// Covers visual prominence as well as clearance: making every card tiny is not a layout fix.
test('embedded collection cards use the available stage without becoming oversized', async ({ mount, page }) => {
    const component = await mount('grid3DToolbar');
    await component.getByRole('button', { name: 'Card style' }).click();
    const measurements: unknown[] = [];
    for (const viewport of [
        { width: 1440, height: 900 },
        { width: 1600, height: 1000 },
        { width: 2018, height: 1010 },
        { width: 2560, height: 1440 },
    ]) {
        await page.setViewportSize(viewport);
        await expect(async () => {
            const card = (await component.locator('[data-grid3d-index="2"]').boundingBox())!;
            const stage = (await component.locator('[data-grid3d-slider]').boundingBox())!;
            const toolbar = (await component.locator('[data-grid3d-toolbar]').boundingBox())!;
            const caption = (await component.locator('[data-grid3d-caption]').boundingBox())!;
            // In a normal embedded host, the central card should read as the focal point.
            expect(card.width).toBeGreaterThanOrEqual(380);
            expect(card.width).toBeLessThanOrEqual(529);
            expect(card.y - toolbar.y - toolbar.height, JSON.stringify({ viewport, card, stage, toolbar, caption })).toBeGreaterThanOrEqual(8);
            expect(caption.y - card.y - card.height).toBeGreaterThanOrEqual(16);
            expect(card.y + card.height).toBeLessThanOrEqual(stage.y + stage.height);
            expect(Math.abs(card.x + card.width / 2 - (stage.x + stage.width / 2))).toBeLessThan(2);
        }).toPass({ timeout: 5000 });
        expect(await component.locator('[data-grid3d-surface]').evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
        measurements.push({ viewport, card: await component.locator('[data-grid3d-index="2"]').boundingBox() });
        await component.screenshot({ path: `test-results/grid3d-balanced-${viewport.width}.png` });
    }
    console.log('Grid3D sizing:', JSON.stringify(measurements));
});

test('opening the Harbour queue keeps the focused collection prominent and centered', async ({ mount, page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    const component = await mount('grid3DToolbar');
    await component.getByRole('button', { name: 'Card style' }).click();
    const measurements: unknown[] = [];
    for (const queueWidth of [0, 350, 0]) {
        // Model only the host bounds: opening the real Harbour queue leaves Folia's height
        // unchanged but removes a sidebar's width. Do not resize the entire test viewport.
        await component.getByTestId('embedded-folia').evaluate((element, width) => {
            (element as HTMLElement).style.width = `calc(100% - ${width}px)`;
        }, queueWidth);
        await expect(async () => {
            const card = (await component.locator('[data-grid3d-index="2"]').boundingBox())!;
            const stage = (await component.locator('[data-grid3d-slider]').boundingBox())!;
            const toolbar = (await component.locator('[data-grid3d-toolbar]').boundingBox())!;
            const caption = (await component.locator('[data-grid3d-caption]').boundingBox())!;
            expect(card.width / stage.width).toBeGreaterThan(0.275);
            expect(card.width / stage.width).toBeLessThan(0.30);
            expect(card.y - toolbar.y - toolbar.height).toBeGreaterThanOrEqual(8);
            expect(caption.y - card.y - card.height).toBeGreaterThanOrEqual(16);
            expect(Math.abs(card.x + card.width / 2 - (stage.x + stage.width / 2))).toBeLessThan(2);
        }).toPass();
        measurements.push({ queueWidth, card: await component.locator('[data-grid3d-index="2"]').boundingBox() });
        await component.screenshot({ path: `test-results/grid3d-large-queue-${queueWidth}.png` });
    }
    console.log('Grid3D queue sizing:', JSON.stringify(measurements));
});

test('screenshot-sized embedded hosts enlarge the card without covering the overview', async ({ mount, page }) => {
    await page.setViewportSize({ width: 2048, height: 1094 });
    const component = await mount('grid3DToolbar');
    await component.getByRole('button', { name: 'Card style' }).click();
    for (const host of [
        { width: 1560, height: 828, minCardWidth: 370 },
        // Same physical space at 125% UI scaling: the height cap must still win over
        // preferred width, preserving both the overview and the player reserve.
        { width: 1248, height: 662, minCardWidth: 230 },
    ]) {
        await component.getByTestId('embedded-folia').evaluate((element, size) => {
            Object.assign((element as HTMLElement).style, {
                flex: 'none', width: `${size.width}px`, height: `${size.height}px`,
            });
        }, host);
        await expect(async () => {
            const card = (await component.locator('[data-grid3d-index="2"]').boundingBox())!;
            const toolbar = (await component.locator('[data-grid3d-toolbar]').boundingBox())!;
            const caption = (await component.locator('[data-grid3d-caption]').boundingBox())!;
            expect(card.width, JSON.stringify({ host, card, toolbar, caption })).toBeGreaterThanOrEqual(host.minCardWidth);
            expect(card.y - toolbar.y - toolbar.height).toBeGreaterThanOrEqual(8);
            expect(caption.y - card.y - card.height).toBeGreaterThanOrEqual(16);
        }).toPass({ timeout: 5000 });
        await component.getByTestId('embedded-folia').screenshot({ path: `test-results/grid3d-large-host-${host.width}.png` });
    }
});

test('height changes do not cause a card-size cliff and preserve the focused collection', async ({ mount, page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    const component = await mount('grid3DToolbar');
    await component.getByRole('button', { name: 'Card style' }).click();
    const widths: number[] = [];
    // Cross the old 660px embedded-container breakpoint in both directions.
    for (const height of [1000, 1020, 1040, 1060, 1040, 1020, 1000]) {
        await page.setViewportSize({ width: 1600, height });
        const card = component.locator('[data-grid3d-index="2"]');
        await expect(async () => {
            const bounds = (await card.boundingBox())!;
            expect(bounds.width).toBeGreaterThan(350);
            const stage = (await component.locator('[data-grid3d-slider]').boundingBox())!;
            expect(Math.abs(bounds.x + bounds.width / 2 - (stage.x + stage.width / 2))).toBeLessThan(2);
        }).toPass();
        widths.push((await card.boundingBox())!.width);
    }
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(3);
    await component.locator('[data-grid3d-slider]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(async () => {
        const stage = (await component.locator('[data-grid3d-slider]').boundingBox())!;
        const card = (await component.locator('[data-grid3d-index="3"]').boundingBox())!;
        expect(Math.abs(card.x + card.width / 2 - (stage.x + stage.width / 2))).toBeLessThan(2);
    }).toPass();
    await component.locator('[data-grid3d-index="3"]').click();
    await expect(component.getByTestId('selected-collection')).toHaveText('probe-3');
});

test('short and scaled hosts keep cards between the toolbar and caption with late metadata', async ({ mount, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const component = await mount('grid3DToolbar');
    await component.getByRole('button', { name: 'Card style' }).click();
    for (const zoom of [1, 1.25, 1.5]) {
        // CSS zoom exercises measured-element geometry and hit testing without relying on
        // physical monitor DPI. Keep the probe's vh-based height within the scaled viewport.
        await page.evaluate(value => {
            document.documentElement.style.zoom = String(value);
            (document.querySelector('#root .h-screen') as HTMLElement).style.height = `calc(100dvh / ${value})`;
        }, zoom);
        for (const height of [900, 640, 540]) {
            await page.setViewportSize({ width: 1440, height });
            await component.getByRole('button', { name: 'Toggle metadata' }).click();
            await expect(async () => {
                const bounds = (await component.locator('[data-grid3d-index="2"]').boundingBox())!;
                const stage = (await component.locator('[data-grid3d-slider]').boundingBox())!;
                const toolbar = (await component.locator('[data-grid3d-toolbar]').boundingBox())!;
                const caption = (await component.locator('[data-grid3d-caption]').boundingBox())!;
                expect(bounds.width).toBeGreaterThanOrEqual(120);
                expect(bounds.y - toolbar.y - toolbar.height, JSON.stringify({ zoom, height, bounds, stage, toolbar, caption })).toBeGreaterThanOrEqual(0);
                expect(bounds.y + bounds.height).toBeLessThanOrEqual(caption.y);
                expect(bounds.y + bounds.height).toBeLessThanOrEqual(stage.y + stage.height);
                expect(Math.abs(bounds.x + bounds.width / 2 - (stage.x + stage.width / 2)), `zoom ${zoom}, height ${height}`).toBeLessThan(3);
            }).toPass({ timeout: 5000 });
            const overview = component.getByRole('button', { name: 'All', exact: true });
            expect(await overview.evaluate(button => {
                const rect = button.getBoundingClientRect();
                return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
            })).toBe(true);
            const surface = component.locator('[data-grid3d-surface]');
            if (await surface.evaluate(el => el.scrollHeight > el.clientHeight + 1)) {
                await surface.evaluate(el => { el.scrollTop = el.scrollHeight; });
                const area = (await surface.boundingBox())!;
                const caption = (await component.locator('[data-grid3d-caption]').boundingBox())!;
                expect(caption.y + caption.height).toBeLessThanOrEqual(area.y + area.height + 1);
                await surface.evaluate(el => { el.scrollTop = 0; });
            }
        }
    }
});
