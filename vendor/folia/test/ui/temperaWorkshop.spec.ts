import { test, expect } from '@playwright/test';
import { APP_VERSION, GUIDE_VERSION_STORAGE_KEY } from '../helpers/appState';

// test/ui/temperaWorkshop.spec.ts
// Real application command routing; the workshop must work without a song or mode switch.
test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page }) => {
    await page.addInitScript(([version, key]) => {
        localStorage.clear();
        localStorage.setItem('i18nextLng', 'zh-CN');
        localStorage.setItem('folia_app_language', 'zh-CN');
        localStorage.setItem('static_mode', 'true');
        localStorage.setItem('visualizer_mode', 'classic');
        localStorage.setItem('folia_startup_view', 'home');
        localStorage.setItem('folia_auto_play_on_launch', 'false');
        localStorage.setItem('player_volume', '0.42');
        localStorage.setItem(key, version);
    }, [APP_VERSION, GUIDE_VERSION_STORAGE_KEY]);
    await page.route('**/__mock_netease__/**', route => route.fulfill({ contentType: 'application/json', body: '{}' }));
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => window.history.state?.view)).toBe('home');
    const palette = page.getByTestId('command-palette-panel');
    await expect.poll(async () => {
        await page.keyboard.press('ControlOrMeta+k');
        return palette.count();
    }).toBeGreaterThan(0);
    await palette.getByRole('combobox').fill('凝彩素材工坊');
    await palette.getByText('凝彩素材工坊', { exact: true }).click();
    await expect(page.getByRole('dialog', { name: '凝彩素材工坊' })).toBeVisible();
});

test('opens from Ctrl+K and cancels without touching playback or navigation', async ({ page }, info) => {
    const modal = page.getByRole('dialog', { name: '凝彩素材工坊' });
    await expect(modal).toHaveCSS('opacity', '1');
    await expect(modal.getByText('把你的图片放进凝彩')).toBeVisible();
    await page.screenshot({ path: info.outputPath('empty-workshop.png') });
    await modal.getByRole('button', { name: '取消编辑' }).click();
    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId('command-palette-panel')).toHaveCount(0);
    expect(await page.evaluate(() => [window.history.state?.view, localStorage.getItem('visualizer_mode'),
        localStorage.getItem('player_volume'), localStorage.getItem('folia_auto_play_on_launch')])).toEqual(['home', 'classic', '0.42', 'false']);
});

test('save writes only Tempera settings, with no automatic mode switch', async ({ page }) => {
    const modal = page.getByRole('dialog', { name: '凝彩素材工坊' });
    await modal.getByRole('slider', { name: '出现频率' }).press('Home');
    await modal.getByRole('button', { name: '保存并应用' }).click();
    await expect(modal).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('tempera_tuning')!).layerImageFrequency)).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('visualizer_mode'))).toBe('classic');
    expect(await page.evaluate(() => Array.from(document.querySelectorAll('audio')).every(audio => audio.paused))).toBe(true);
});

test('nested backup menu and Escape do not discard the editor underneath', async ({ page }) => {
    const modal = page.getByRole('dialog', { name: '凝彩素材工坊' });
    await modal.getByRole('slider', { name: '出现频率' }).press('Home');
    await modal.getByRole('button', { name: '导入备份', exact: true }).click();
    await expect(modal.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(modal.getByRole('menu')).toHaveCount(0);
    await expect(modal).toBeVisible();
    page.once('dialog', question => question.dismiss());
    await page.keyboard.press('Escape');
    await expect(modal).toBeVisible();
    page.once('dialog', question => question.accept());
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId('command-palette-panel')).toHaveCount(0);
});

test('keyboard placement and range edits are not swallowed by the palette underneath', async ({ page }) => {
    const modal = page.getByRole('dialog', { name: '凝彩素材工坊' });
    await modal.locator('input[type=file][multiple]').setInputFiles({ name: 'Keyboard.svg', mimeType: 'image/svg+xml',
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><circle cx="60" cy="60" r="50" fill="#aaa"/></svg>') });
    const target = modal.getByRole('button', { name: '顶部 · 偏左', exact: true });
    await target.focus();
    await page.keyboard.press('Enter');
    await expect(target).toHaveAttribute('aria-pressed', 'true');
    const slider = modal.getByRole('slider', { name: '大小', exact: true });
    await slider.press('Home');
    await slider.press('ArrowUp');
    await expect(slider).toHaveValue('0.06');
    await page.keyboard.press('ControlOrMeta+k');
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: '保存并应用' }).focus();
    await page.keyboard.press('Enter');
    await expect(modal).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('tempera_tuning')!).layerImages[0])).toMatchObject({ align: 'left', verticalAlign: 'top', scale: .06 });
    expect(await page.evaluate(() => localStorage.getItem('visualizer_mode'))).toBe('classic');
});
