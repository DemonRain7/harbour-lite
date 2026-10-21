import { test, expect, type Page } from '@playwright/test';
import { APP_VERSION, GUIDE_VERSION_STORAGE_KEY } from '../helpers/appState';

// test/ui/startupView.spec.ts
// Real application boot, navigation and IndexedDB queue restoration in an isolated browser.
test.use({ serviceWorkers: 'block' });

const seed = async (page: Page, launch?: 'home' | 'player' | 'lattice', legacy?: string) => {
    await page.addInitScript(({ version, guideKey, launchView, oldValue }) => {
        if (localStorage.getItem('startup_test_seeded')) return;
        localStorage.clear();
        localStorage.setItem('startup_test_seeded', 'true');
        localStorage.setItem('i18nextLng', 'zh-CN');
        localStorage.setItem('folia_app_language', 'zh-CN');
        localStorage.setItem('static_mode', 'true');
        localStorage.setItem('visualizer_mode', 'classic');
        localStorage.setItem('folia_auto_play_on_launch', 'false');
        localStorage.setItem('player_volume', '0.42');
        localStorage.setItem(guideKey, version);
        if (launchView) localStorage.setItem('folia_startup_view', launchView);
        if (oldValue) localStorage.setItem('open_player_on_launch', oldValue);
    }, { version: APP_VERSION, guideKey: GUIDE_VERSION_STORAGE_KEY, launchView: launch, oldValue: legacy });
    await page.route('**/__mock_netease__/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
};

const currentView = (page: Page) => page.evaluate(() => window.history.state?.view);

for (const legacy of [undefined, 'true', 'false']) {
    test(`defaults to the library with legacy launch flag ${legacy}, including reload`, async ({ page }) => {
        await seed(page, undefined, legacy);
        await page.goto('/');
        await expect.poll(() => currentView(page)).toBe('home');
        await expect(page.getByRole('button', { name: '歌单', exact: true })).toBeVisible();
        await expect(page.locator('.lattice-root')).toHaveCount(0);
        await page.reload();
        await expect.poll(() => currentView(page)).toBe('home');
        await expect(page.locator('.lattice-root')).toHaveCount(0);
    });
}

for (const view of ['home', 'player'] as const) {
    test(`honours explicit ${view} launch choice`, async ({ page }) => {
        await seed(page, view);
        await page.goto('/');
        await expect.poll(() => currentView(page)).toBe(view);
        await expect(page.locator('.lattice-root')).toHaveCount(0);
    });
}

test('command changes the next launch, not the current view or listening preferences', async ({ page }) => {
    await seed(page, 'lattice');
    await page.goto('/');
    await expect(page.locator('.lattice-root')).toBeVisible();
    const palette = page.getByTestId('command-palette-panel');
    await expect.poll(async () => {
        await page.keyboard.press('ControlOrMeta+k');
        return palette.count();
    }).toBeGreaterThan(0);
    await palette.getByRole('combobox').fill('qidongshouye');
    await palette.getByText('启动进入曲库首页', { exact: true }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('folia_startup_view'))).toBe('home');
    await expect.poll(() => currentView(page)).toBe('lattice');
    await expect.poll(() => page.evaluate(() => [localStorage.getItem('folia_auto_play_on_launch'), localStorage.getItem('player_volume')])).toEqual(['false', '0.42']);
    await page.reload();
    await expect.poll(() => currentView(page)).toBe('home');
});

test('restores the saved queue without mounting the wall or autoplay; Ctrl+B still opens it', async ({ page }, testInfo) => {
    await seed(page);
    await page.goto('/');
    await expect.poll(() => currentView(page)).toBe('home');
    await page.evaluate(async () => {
        const modulePath = '/src/services/db.ts';
        const { saveToCache } = await import(modulePath);
        const queue = Array.from({ length: 24 }, (_, i) => ({
            id: i + 1, name: `Saved poster ${i + 1}`, artists: [{ id: 1, name: 'Startup fixture' }],
            album: { id: 1, name: 'Saved queue' }, durationMs: 180000,
            sourceRef: { kind: 'online', providerId: 'netease', mediaId: i + 1 },
        }));
        await saveToCache('last_song', queue[0]);
        await saveToCache('last_queue', queue);
    });
    await page.reload();
    await expect.poll(() => currentView(page)).toBe('home');
    await expect(page.locator('.lattice-root')).toHaveCount(0);
    await expect.poll(() => page.evaluate(async () => {
        const path = '/src/stores/usePlaybackStore.ts';
        const { usePlaybackStore } = await import(path);
        return usePlaybackStore.getState().playQueue.length;
    })).toBe(24);
    expect(await page.evaluate(() => Array.from(document.querySelectorAll('audio')).every(audio => audio.paused))).toBe(true);
    await page.keyboard.press('ControlOrMeta+b');
    await expect(page.locator('.lattice-poster').first()).toBeVisible();
    await page.keyboard.press('ControlOrMeta+b');
    await expect.poll(() => currentView(page)).toBe('home');
    await page.screenshot({ path: testInfo.outputPath('startup-collage.png') });
});

test('FM keeps its player view without replacing an explicit collage launch preference', async ({ page }) => {
    await seed(page, 'lattice');
    await page.goto('/');
    await expect(page.locator('.lattice-root')).toBeVisible();
    await page.evaluate(async () => {
        const path = '/src/stores/usePlaybackStore.ts';
        const { usePlaybackStore } = await import(path);
        usePlaybackStore.getState().setIsFmMode(true);
    });
    await expect.poll(() => currentView(page)).toBe('player');
    expect(await page.evaluate(() => localStorage.getItem('folia_startup_view'))).toBe('lattice');
});
