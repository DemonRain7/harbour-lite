import { test, expect } from '@playwright/test';
import { installBaseState, mockNeteaseApi, svgDataUrl } from './helpers/appFixtures';

// test/ui/harbourRuntime.probe.ts
// The whole App, not just a poster fixture: exercise the same playlist with and
// without the additive Harbour transport. Exact time stays outside React.
test.use({ serviceWorkers: 'block' });

for (const bridge of [false, true]) test(`playlist runtime: Harbour transport ${bridge ? 'on' : 'off'}`, async ({ page }, testInfo) => {
    await installBaseState(page, { neteaseMode: 'logged-in' });
    await mockNeteaseApi(page, 'logged-in');
    const songs = Array.from({ length: 18 }, (_, i) => ({ id: 50000 + i, name: `Runtime track ${i}`,
        ar: [{ id: 1, name: 'Fixture artist' }], dt: 180000,
        al: { id: 2, name: 'Fixture album', picUrl: svgDataUrl(String(i), '#426283') } }));
    await page.route('**/__mock_netease__/playlist/track/all?**', route => route.fulfill({ json: { code: 200, songs } }));
    await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
        ? route.fallback() : route.abort('blockedbyclient'));
    await page.addInitScript(enabled => {
        if (!enabled) return;
        (window as any).__bridgePublications = 0;
        (window as any).harbourFolia = {
            ready: async () => true,
            publish: () => { (window as any).__bridgePublications++; },
            onCommand: () => () => {},
        };
    }, bridge);
    await page.goto('/');
    await page.getByRole('heading', { name: 'Daily Mix' }).first().click();
    await expect(page.locator('[data-playlist-collage="9001"] .lattice-poster').first()).toBeVisible();
    await expect(page.locator('[data-folia-visualizer]')).toBeEmpty();
    await page.waitForTimeout(3000); // Loading, entry wave and automatic camera settle.

    const clock = await page.evaluate(async () => {
        const signalPath = '/src/stores/motionSignals.ts';
        const { currentTime, lyricCurrentTime } = await import(signalPath);
        (window as any).__renderCounts = {};
        const publications = (window as any).__bridgePublications || 0;
        for (let frame = 1; frame <= 240; frame++) {
            await new Promise(requestAnimationFrame);
            currentTime.set(frame / 500);
            lyricCurrentTime.set(frame / 500);
        }
        return { counts: { ...(window as any).__renderCounts },
            publications: ((window as any).__bridgePublications || 0) - publications };
    });
    for (const name of ['App', 'GridView', 'Lattice', 'PosterWall', 'LatticePoster']) {
        expect(clock.counts[name] || 0, `${name} must not track precise time in React`).toBe(0);
    }
    expect(clock.publications).toBeLessThan(10); // Never per-frame IPC, including on a slow runner.
    if (bridge) expect(clock.publications).toBeGreaterThan(0);

    const sliders = await page.evaluate(async () => {
        const path = '/src/stores/useAudioSettingsStore.ts';
        const { useAudioSettingsStore } = await import(path);
        (window as any).__renderCounts = {};
        for (let step = 0; step < 10; step++) {
            useAudioSettingsStore.getState().handleSetVolume((step + 1) / 20);
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        return { ...(window as any).__renderCounts };
    });
    expect(sliders.App).toBeGreaterThan(0); // Ensure the test actually changed application state.
    expect(sliders.GridView || 0, 'playback Context must not invalidate the playlist loader/grid').toBe(0);
    expect(sliders.LatticePoster || 0, 'volume must not repaint every cover').toBe(0);

    await page.evaluate(() => { (window as any).__renderCounts = {}; });
    await page.mouse.move(850, 650);
    await page.mouse.down();
    await page.mouse.move(350, 450, { steps: 60 });
    await page.mouse.up();
    const dragging = await page.evaluate(() => ({ ...(window as any).__renderCounts }));
    expect(dragging.GridView || 0, 'pointer motion must not flow into the library').toBe(0);
    await testInfo.attach('runtime-counts.json', { body: JSON.stringify({ bridge, clock, sliders, dragging }), contentType: 'application/json' });
    console.log('FOLIA_REACT_RUNTIME', JSON.stringify({ bridge, clock, sliders, dragging }));
    await page.locator('.lattice-back').click();
    await expect(page.getByRole('heading', { name: 'Daily Mix' }).first()).toBeVisible();
});
