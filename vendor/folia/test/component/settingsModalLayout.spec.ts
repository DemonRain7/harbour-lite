import { expect, test } from './fixtures';

// Exercise the real modal's flex sizing, not a copy of its surrounding layout.
test('help footer remains reachable in a short embedded viewport', async ({ mount, page }, testInfo) => {
    await page.setViewportSize({ width: 1200, height: 580 });
    const root = await mount('settingsModalLayout');
    const scroll = root.locator('[data-folia-keyboard-window] .custom-scrollbar').first();
    const footer = root.getByRole('button', { name: 'Click to copy version info', exact: true });
    await expect(footer).toBeAttached();
    await scroll.evaluate(node => node.scrollTo({ top: node.scrollHeight }));
    await page.waitForTimeout(400);
    await root.screenshot({ path: testInfo.outputPath('help-footer.png') });
    await expect(footer).toBeInViewport();
    const dimensions = await scroll.evaluate(node => {
        const parent = node.parentElement!.getBoundingClientRect();
        const rect = node.getBoundingClientRect();
        return { bottom: rect.bottom, parentBottom: parent.bottom, client: node.clientHeight, content: node.scrollHeight };
    });
    expect(dimensions.bottom).toBeLessThanOrEqual(dimensions.parentBottom + 1);
    expect(dimensions.content).toBeGreaterThan(dimensions.client);
});

const scenarios = [
    { width: 2024, height: 974, language: 'zh-CN', daylight: false },
    { width: 1200, height: 580, language: 'zh-CN', daylight: true },
    { width: 900, height: 600, language: 'en', daylight: false },
    { width: 768, height: 450, language: 'zh-CN', daylight: true },
    { width: 560, height: 420, language: 'en', daylight: false },
    { width: 375, height: 640, language: 'zh-CN', daylight: true },
    { width: 320, height: 360, language: 'en', daylight: false },
];

for (const scenario of scenarios) {
    test(`help/options stay usable at ${scenario.width}x${scenario.height} ${scenario.language}`, async ({ mount, page }, testInfo) => {
        await page.setViewportSize(scenario);
        await page.addInitScript(({ language, daylight }) => {
            localStorage.setItem('i18nextLng', language);
            localStorage.setItem('default_theme_daylight', String(daylight));
            localStorage.setItem('follow_system_theme', 'false');
        }, scenario);
        const root = await mount('settingsModalLayout', { daylight: scenario.daylight });
        const zh = scenario.language === 'zh-CN';
        const help = zh ? '帮助' : 'Help';
        const options = zh ? '选项' : 'Options';
        const close = zh ? '关闭' : 'Close';
        const dialog = root.getByRole('dialog');
        const helpScroll = dialog.getByRole('region', { name: help, exact: true });
        await expect(helpScroll).toBeVisible();
        await helpScroll.focus();
        await page.keyboard.press('End');
        const version = dialog.locator('button[title]').last();
        await expect(version).toBeInViewport({ ratio: 1 });
        await expect(dialog.getByRole('button', { name: help, exact: true })).toBeInViewport({ ratio: 1 });
        await expect(dialog.getByRole('button', { name: close, exact: true })).toBeInViewport({ ratio: 1 });
        const size = await helpScroll.evaluate(node => ({ width: node.clientWidth, content: node.scrollWidth }));
        expect(size.content).toBeLessThanOrEqual(size.width + 1);
        await root.screenshot({ path: testInfo.outputPath('help-bottom.png') });

        await dialog.getByRole('button', { name: options, exact: true }).click();
        const content = dialog.getByRole('region');
        await expect(content).toHaveCount(1);
        // Tab and panel sizing animate independently. Measure the destination scroll area, not
        // the outgoing help tab's intermediate height during popLayout.
        await expect(content.locator('..')).toHaveCSS('transform', 'none');
        await expect.poll(() => dialog.evaluate(node => node.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0);
        await content.evaluate(node => node.scrollTo({ top: node.scrollHeight }));
        const importButton = content.getByRole('button', { name: zh ? '导入配置' : 'Import Config', exact: true });
        await expect(importButton).toBeInViewport({ ratio: 1 });
        const bounds = await dialog.boundingBox();
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(scenario.height + 1);
        await root.screenshot({ path: testInfo.outputPath('options-bottom.png') });

        await dialog.getByRole('button', { name: help, exact: true }).click();
        await expect.poll(() => helpScroll.evaluate(node => node.scrollTop)).toBe(0);
        await dialog.getByRole('button', { name: close, exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await root.getByRole('button', { name: 'Open settings fixture', exact: true }).click();
        await expect(dialog).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
    });
}

test('an already open help modal adapts to a smaller viewport', async ({ mount, page }) => {
    await page.setViewportSize({ width: 1600, height: 1100 });
    const root = await mount('settingsModalLayout');
    const dialog = root.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.setViewportSize({ width: 720, height: 400 });
    const scroll = dialog.getByRole('region', { name: 'Help', exact: true });
    await scroll.focus();
    await page.keyboard.press('End');
    await expect(dialog.getByRole('button', { name: 'Click to copy version info', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeInViewport({ ratio: 1 });
});
