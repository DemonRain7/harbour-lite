import { test, expect, type Page } from '@playwright/test';
import { APP_VERSION, GUIDE_VERSION_STORAGE_KEY } from '../helpers/appState';

// test/ui/playbackEntrySettings.spec.ts
// The real settings cards persist both choices across fresh app loads, without music accounts.
test.use({ serviceWorkers: 'block' });

async function openSettings(page: Page) {
    await page.evaluate(async () => {
        const path = '/src/stores/useSettingsModalStore.ts';
        const { useSettingsModalStore } = await import(path);
        useSettingsModalStore.getState().openSettings('options', 'general', null, 'playbackEntryView');
    });
    await expect(page.locator('#settings-playbackEntryView')).toBeVisible();
}

for (const language of ['en', 'zh-CN'] as const) {
    test(`${language}: change both defaults, save immediately, and retain after reload`, async ({ page }, testInfo) => {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(({ version, guideKey, language }) => {
            // Seed once: clearing on every navigation would conceal persistence bugs.
            if (sessionStorage.getItem('entry-settings-fixture')) return;
            sessionStorage.setItem('entry-settings-fixture', '1');
            localStorage.setItem('i18nextLng', language);
            localStorage.setItem('default_theme_daylight', String(language === 'en'));
            localStorage.setItem('static_mode', 'true');
            localStorage.setItem('player_volume', '0');
            localStorage.setItem('last_app_view', 'home');
            localStorage.setItem(guideKey, version);
        }, { version: APP_VERSION, guideKey: GUIDE_VERSION_STORAGE_KEY, language });
        await page.route('**/__mock_netease__/**', route => route.fulfill({ json: {} }));
        await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
            ? route.fallback() : route.abort('blockedbyclient'));
        await page.goto('/');
        await openSettings(page);
        const section = page.locator('#settings-playbackEntryView');
        const player = section.getByRole('button', { name: language === 'en' ? 'Visualizer' : '可视化', exact: true });
        const lattice = section.getByRole('button', { name: language === 'en' ? 'Lattice (queue collage)' : 'Lattice（队列拼贴）', exact: true });
        // A fresh profile defaults to the visualizer; no Harbour override may force Lattice.
        await expect(player).toHaveAttribute('aria-pressed', 'true');
        for (const [view, choice, other] of [['lattice', lattice, player], ['player', player, lattice]] as const) {
            await choice.click();
            await expect(choice).toHaveAttribute('aria-pressed', 'true');
            await expect(other).toHaveAttribute('aria-pressed', 'false');
            await expect(choice).toContainText(language === 'en' ? 'Selected' : '已选择');
            expect(await page.evaluate(() => localStorage.getItem('playback_entry_view'))).toBe(view);
            expect(await page.evaluate(() => localStorage.getItem('playback_entry_view_chosen'))).toBe('true');
            await page.reload();
            await openSettings(page);
            await expect(choice).toHaveAttribute('aria-pressed', 'true');
            await expect(other).toHaveAttribute('aria-pressed', 'false');
        }
        await section.screenshot({ path: testInfo.outputPath(`entry-settings-${language}.png`) });
        expect(errors).toEqual([]);
    });
}
