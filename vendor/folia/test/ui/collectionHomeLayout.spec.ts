import { expect, test } from '@playwright/test';
import { installBaseState, mockNeteaseApi, openApp, svgDataUrl } from './helpers/appFixtures';

// test/ui/collectionHomeLayout.spec.ts

test('real Folia home shares proportional spacing with its embedded host', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    // No real accounts, covers or audio. The paused track only enables the real
    // floating controls and their reserved space in Grid3D, not a second player.
    await page.route(/^https?:\/\//, route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
        ? route.continue() : route.abort());
    await installBaseState(page, { neteaseMode: 'logged-in' });
    await mockNeteaseApi(page, 'logged-in');
    await openApp(page);
    await expect(page.getByRole('heading', { name: 'Daily Mix' }).first()).toBeVisible();
    await page.evaluate(async cover => {
        const path = '/src/stores/usePlaybackStore.ts';
        const state = (await import(path)).usePlaybackStore.getState();
        state.setCurrentSong({ id: 'layout-only', name: 'Layout fixture', artists: 'Fixture', album: 'Fixture', coverUrl: cover, duration: 180 });
        state.setDuration(180);
    }, svgDataUrl('Fixture', '#8b668b'));
    for (const size of [{ width: 1640, height: 900 }, { width: 1248, height: 662 }, { width: 1640, height: 900 }]) {
        await page.setViewportSize(size);
        await expect(async () => {
            const focus = (await page.locator('[data-grid3d-index="0"]').boundingBox())!;
            const caption = (await page.locator('[data-grid3d-caption]').boundingBox())!;
            const reserve = (await page.locator('[data-folia-home-player-space]').boundingBox())!;
            const toolbar = (await page.locator('[data-grid3d-toolbar]').boundingBox())!;
            expect(focus.width / size.width, JSON.stringify({ size, focus, caption, reserve, toolbar })).toBeGreaterThan(0.22);
            expect(focus.width / size.width).toBeLessThan(0.30);
            expect(Math.abs(focus.x + focus.width / 2 - size.width / 2)).toBeLessThan(2);
            expect(focus.y - toolbar.y - toolbar.height).toBeGreaterThan(8);
            expect(caption.y - focus.y - focus.height).toBeGreaterThan(16);
            expect(reserve.height).toBeGreaterThanOrEqual(88);
            expect(caption.y + caption.height).toBeLessThanOrEqual(reserve.y + 1);
            expect(reserve.y + reserve.height).toBeLessThanOrEqual(size.height + 1);
        }).toPass({ timeout: 8000 });
        await page.screenshot({ path: `test-results/folia-home-layout-${size.width}.png` });
    }
    await page.locator('[data-grid3d-index="0"]').click();
    await expect(page.locator('[data-playlist-collage="9001"]')).toBeVisible();
    expect(errors).toEqual([]);
});
