import { test, expect } from './fixtures';

// test/component/visualizerLifecycle.spec.ts
test('Tempera -> Classic preserves the player through repeated real scene teardown', async ({ mount, page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    const probe = await mount('visualizerLifecycle');
    const player = probe.locator('[data-player-id]');
    const id = await player.getAttribute('data-player-id');
    for (let index = 0; index < 5; index++) {
        await probe.getByRole('button', { name: 'tempera', exact: true }).click();
        await expect(probe.locator('[data-visualizer-surface] canvas')).not.toHaveCount(0);
        await page.waitForTimeout(700);
        await probe.getByRole('button', { name: 'Seek scene', exact: true }).click();
        await page.waitForTimeout(300);
        await probe.getByRole('button', { name: 'classic', exact: true }).click();
        await page.waitForTimeout(300);
        expect(errors, errors.join('\n')).toEqual([]);
        await expect(player).toHaveAttribute('data-player-id', id!);
        const tick = Number(await probe.getByTestId('player-alive').textContent());
        await expect.poll(async () => Number(await probe.getByTestId('player-alive').textContent())).toBeGreaterThan(tick);
    }
});

for (const fault of ['render', 'commit', 'lazy']) {
    test(`${fault} failure stays inside the visualizer and switching style recovers`, async ({ mount, page }, testInfo) => {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        const probe = await mount('visualizerLifecycle');
        const parent = probe.locator('[data-player-id]');
        const id = await parent.getAttribute('data-player-id');
        await probe.getByRole('button', { name: `Fault ${fault}`, exact: true }).click();
        if (fault === 'commit') {
            await page.waitForTimeout(150);
            await probe.getByRole('button', { name: 'classic', exact: true }).click();
        }
        await expect(probe.getByTestId('visualizer-fallback')).toBeVisible();
        if (fault === 'render') await page.screenshot({ path: testInfo.outputPath('visualizer-recovery.png') });
        await expect(parent).toHaveAttribute('data-player-id', id!);
        const before = Number(await probe.getByTestId('player-alive').textContent());
        await expect.poll(async () => Number(await probe.getByTestId('player-alive').textContent())).toBeGreaterThan(before);
        await probe.getByRole('button', { name: 'still', exact: true }).click();
        await expect(probe.getByTestId('visualizer-fallback')).toHaveCount(0);
        expect(errors).toEqual([]);
    });
}

test('a Pixi destroy exception cannot strand its host or unmount the player', async ({ mount, page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const probe = await mount('visualizerLifecycle');
    const id = await probe.locator('[data-player-id]').getAttribute('data-player-id');
    for (let i = 0; i < 3; i++) {
        await probe.getByRole('button', { name: 'Fault pixi', exact: true }).click();
        await expect(probe.getByTestId('cleanup-host').locator('canvas')).toHaveCount(1);
        await probe.getByRole('button', { name: 'classic', exact: true }).click();
        await expect(probe.getByTestId('cleanup-host')).toHaveCount(0);
        await expect(probe.getByTestId('visualizer-fallback')).toHaveCount(0);
        await expect(probe.locator('[data-player-id]')).toHaveAttribute('data-player-id', id!);
    }
    expect(errors).toEqual([]);
});
