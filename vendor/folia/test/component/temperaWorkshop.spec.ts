import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// test/component/temperaWorkshop.spec.ts
// Real dialog, pointer/keyboard events, IndexedDB and settings writes in isolated browser contexts.
const saved = (page: Page) => page.getByTestId('workshop-saved').textContent().then(text => JSON.parse(text!));
const exists = (page: Page, id: string) => page.evaluate(async key => {
    const path = '/src/services/temperaLayerImages.ts';
    return Boolean(await (await import(path)).getTemperaLayerImage(key));
}, id);
const upload = { name: 'Own artwork.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><circle cx="60" cy="60" r="52" fill="#ad99e8"/></svg>') };
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Tempera image workshop', exact: true });

test('preview, drag and sliders stay draft-only until Save; reopening reads the saved pool', async ({ mount, page }) => {
    const root = await mount('temperaWorkshop');
    await root.locator('.tempera-workshop-entry').click();
    const modal = dialog(page), stage = modal.getByTestId('tempera-placement-preview');
    await expect(modal.getByTestId('tempera-preview-image')).toBeVisible();
    const original = await saved(page);
    const box = (await stage.boundingBox())!;
    await page.mouse.move(box.x + box.width * .7, box.y + box.height * .5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .17, box.y + box.height * .17, { steps: 12 });
    expect(await saved(page)).toEqual(original);
    await page.mouse.up();
    await expect(modal.getByRole('button', { name: 'Top · Left', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await modal.getByRole('slider').nth(0).press('End');
    await modal.getByRole('slider').nth(2).press('Home');
    await expect(modal.getByText('0%: images are kept but will not appear during playback.')).toBeVisible();
    await modal.getByRole('button', { name: 'Try another shot' }).click();
    expect(await saved(page)).toEqual(original);
    await modal.getByRole('button', { name: 'Save and apply' }).click();
    await expect(modal).toHaveCount(0);
    expect((await saved(page)).layerImages[0]).toMatchObject({ align: 'left', verticalAlign: 'top', scale: 2 });
    expect((await saved(page)).layerImageFrequency).toBe(0);
    await root.locator('.tempera-workshop-entry').click();
    await expect(dialog(page).getByRole('slider').nth(0)).toHaveValue('2');
    await expect(dialog(page).getByRole('slider').nth(2)).toHaveValue('0');
});

test('Cancel discards uploads and removal without deleting originals', async ({ mount, page }) => {
    const root = await mount('temperaWorkshop');
    await root.locator('.tempera-workshop-entry').click();
    const modal = dialog(page);
    await modal.getByRole('button', { name: 'Remove image', exact: true }).click();
    await modal.locator('input[type=file][multiple]').setInputFiles(upload);
    const added = modal.locator('.tempera-workshop-asset', { hasText: upload.name });
    await expect(added).toBeVisible();
    const id = (await added.getAttribute('data-image-id'))!;
    expect(await exists(page, id)).toBe(true);
    await modal.getByRole('button', { name: 'Cancel edits' }).click();
    await expect.poll(() => exists(page, id)).toBe(false);
    expect(await exists(page, 'workshop-probe-0')).toBe(true);
    expect((await saved(page)).layerImages).toHaveLength(3);
});

test('Save reclaims removed images only after settings commit', async ({ mount, page }) => {
    const root = await mount('temperaWorkshop');
    await root.locator('.tempera-workshop-entry').click();
    await dialog(page).getByRole('button', { name: 'Remove image', exact: true }).click();
    expect(await exists(page, 'workshop-probe-0')).toBe(true);
    await dialog(page).getByRole('button', { name: 'Save and apply' }).click();
    await expect.poll(() => exists(page, 'workshop-probe-0')).toBe(false);
    expect((await saved(page)).layerImages).toHaveLength(2);
});

test('failed commits preserve the draft and original image files', async ({ mount, page }) => {
    const root = await mount('temperaWorkshop');
    await root.getByRole('checkbox').check();
    await root.locator('.tempera-workshop-entry').click();
    await dialog(page).getByRole('button', { name: 'Remove image', exact: true }).click();
    await dialog(page).getByRole('button', { name: 'Save and apply' }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(root.getByTestId('workshop-status')).toContainText('Could not save');
    await expect(dialog(page).getByRole('alert')).toBeInViewport({ ratio: 1 });
    expect(await exists(page, 'workshop-probe-0')).toBe(true);
    expect((await saved(page)).layerImages).toHaveLength(3);
});

test('an externally updated pool is not overwritten by an older draft', async ({ mount, page }) => {
    const root = await mount('temperaWorkshop');
    await root.locator('.tempera-workshop-entry').click();
    await dialog(page).getByRole('button', { name: 'Remove image', exact: true }).click();
    await page.evaluate(async () => {
        const path = '/src/stores/useVisualizerSettingsStore.ts';
        (await import(path)).useVisualizerSettingsStore.getState().handleSetTemperaTuning({ layerImageFrequency: .2 });
    });
    await dialog(page).getByRole('button', { name: 'Save and apply' }).click();
    await expect(root.getByTestId('workshop-status')).toContainText('changed elsewhere');
    expect((await saved(page)).layerImageFrequency).toBe(.2);
    expect(await exists(page, 'workshop-probe-0')).toBe(true);
    await dialog(page).getByRole('button', { name: 'Cancel edits' }).click();
});

test('Escape asks before discarding and Tab stays in the workshop', async ({ mount, page }) => {
    const root = await mount('temperaWorkshop');
    await root.locator('.tempera-workshop-entry').click();
    await dialog(page).getByRole('button', { name: 'Close image workshop' }).focus();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog(page).getByRole('button', { name: 'Save and apply' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog(page).getByRole('button', { name: 'Close image workshop' })).toBeFocused();
    await dialog(page).getByRole('button', { name: 'Remove image', exact: true }).click();
    page.once('dialog', question => question.dismiss());
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeVisible();
    page.once('dialog', question => question.accept());
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    expect(await exists(page, 'workshop-probe-0')).toBe(true);
});

test('ZIP export/import reuses the existing format and fresh ids', async ({ mount, page }) => {
    const root = await mount('temperaWorkshop');
    await root.locator('.tempera-workshop-entry').click();
    const download = page.waitForEvent('download');
    await dialog(page).getByRole('button', { name: 'Export backup', exact: true }).click();
    const file = await (await download).path();
    await dialog(page).locator('input[accept="application/zip,.zip"]').setInputFiles(file!);
    await expect(dialog(page).locator('.tempera-workshop-asset')).toHaveCount(6);
    await dialog(page).getByRole('button', { name: 'Save and apply' }).click();
    const images = (await saved(page)).layerImages;
    expect(new Set(images.map((image: { id: string }) => image.id)).size).toBe(6);
    expect((await saved(page)).layerImageFrequency).toBe(.8);
});

test('unmount rolls back only newly created draft images', async ({ mount, page }) => {
    const root = await mount('temperaWorkshop');
    await root.locator('.tempera-workshop-entry').click();
    await dialog(page).locator('input[type=file][multiple]').setInputFiles(upload);
    const added = dialog(page).locator('.tempera-workshop-asset', { hasText: upload.name });
    await expect(added).toBeVisible();
    const id = (await added.getAttribute('data-image-id'))!;
    await page.evaluate(() => window.dispatchEvent(new Event('workshop-probe-unmount')));
    await expect.poll(() => exists(page, id)).toBe(false);
    expect(await exists(page, 'workshop-probe-0')).toBe(true);
    expect((await saved(page)).layerImages).toHaveLength(3);
});

for (const [width, height] of [[1280, 900], [1100, 620], [390, 740]]) {
    for (const day of [false, true]) {
        test(`responsive workshop ${width}×${height}, daylight=${day}`, async ({ mount, page }, info) => {
            await page.setViewportSize({ width, height });
            const root = await mount('temperaWorkshop');
            await page.evaluate(async () => { const path = '/src/i18n/config.ts'; await (await import(path)).default.changeLanguage('zh-CN'); });
            if (day) await root.getByRole('button', { name: 'Toggle daylight' }).click();
            await root.locator('.tempera-workshop-entry').click();
            const modal = page.getByRole('dialog', { name: '凝彩素材工坊', exact: true });
            await expect(modal).toHaveCSS('opacity', '1');
            await expect(modal.getByRole('button', { name: '保存并应用' })).toBeInViewport({ ratio: 1 });
            await expect(modal.getByRole('button', { name: '取消编辑' })).toBeInViewport({ ratio: 1 });
            expect(await modal.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
            await expect(modal.getByTestId('tempera-preview-image')).toBeVisible();
            await page.screenshot({ path: info.outputPath('workshop.png') });
            await modal.getByRole('slider').last().scrollIntoViewIfNeeded();
            await expect(modal.getByRole('slider').last()).toBeInViewport({ ratio: 1 });
        });
    }
}
