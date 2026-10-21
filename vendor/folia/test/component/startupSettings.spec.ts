import { expect, test } from './fixtures';

// test/component/startupSettings.spec.ts
// The real desktop preferences row uses the same stored choice as startup navigation.
for (const width of [1200, 560]) {
    test(`launch selector remains usable at ${width}px`, async ({ mount, page }, testInfo) => {
        await page.setViewportSize({ width, height: 680 });
        await page.addInitScript(() => {
            Object.defineProperty(window, 'electron', { value: {
                platform: 'win32',
                getSettings: async () => ({}),
                getCacheDirectory: async () => ({ path: '', isDefault: true }),
            } });
        });
        const root = await mount('settingsModalLayout');
        const dialog = root.getByRole('dialog');
        await dialog.getByRole('button', { name: 'Options', exact: true }).click();
        await dialog.getByRole('button', { name: 'Desktop settings', exact: true }).click();
        const select = dialog.getByRole('button', { name: 'Launch view', exact: true });
        await expect(select).toHaveText('Queue collage');
        await select.click();
        await expect(page.getByRole('listbox', { name: 'Launch view' })).toBeVisible();
        await page.getByRole('option', { name: 'Library home', exact: true }).click();
        await expect(select).toHaveText('Library home');
        expect(await page.evaluate(() => localStorage.getItem('folia_startup_view'))).toBe('home');
        await select.click();
        await page.getByRole('option', { name: 'Queue collage', exact: true }).click();
        await expect(select).toHaveText('Queue collage');
        await expect(page.getByRole('listbox', { name: 'Launch view' })).toHaveCount(0);
        await expect(select).toBeInViewport({ ratio: 1 });
        const overflow = await select.evaluate(node => node.scrollWidth - node.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);
        await root.screenshot({ path: testInfo.outputPath('startup-settings.png') });
    });
}
